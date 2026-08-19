require('dotenv').config()
const express = require('express')
const cors = require('cors')
const axios = require('axios')
const cron = require('node-cron')
const { createClient } = require('@supabase/supabase-js')
const webpush = require('web-push')
const ws = require('ws')

const app = express()
app.use(cors())
app.use(express.json())

const sb = createClient(
  process.env.SUPABASE_URL || 'https://foshqdjgbcigggrcjtap.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvc2hxZGpnYmNpZ2dncmNqdGFwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTQwMDAyMSwiZXhwIjoyMDk0OTc2MDIxfQ.6h_Pouyxs73jug7JJtCtfj50JJPi1whWnAkdJuPNSoI',
  {
    // Node.js não tem WebSocket nativo — o Supabase Realtime precisa do pacote "ws" pra funcionar.
    // Este backend não usa Realtime (só REST via .from()), mas isso evita o erro/aviso na inicialização.
    realtime: {
      transport: ws
    }
  }
)

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '4022957335913783'
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'f9jB9yc6UvrAnz4kjT6u02xMxjbvn7z3'
const RAILWAY_URL      = 'https://tmp10-backend-v2-production.up.railway.app'
const ERP_URL          = process.env.ERP_URL || 'https://roaring-pixie-c02520.netlify.app'

// ── Shopee Open Platform (OAuth v2) ─────────────────────────────────
const SHOPEE_PARTNER_ID  = (process.env.SHOPEE_PARTNER_ID || '').trim()
const SHOPEE_PARTNER_KEY = (process.env.SHOPEE_PARTNER_KEY || '').trim()
// Ambiente de teste (sandbox) — quando o app virar produção, troca pra https://partner.shopeemobile.com
const SHOPEE_HOST        = process.env.SHOPEE_HOST || 'https://partner.test-stable.shopeemobile.com'
const crypto = require('crypto')
function shopeeSign(path, timestamp, accessToken = '', shopId = '') {
  const baseString = `${SHOPEE_PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`
  return crypto.createHmac('sha256', SHOPEE_PARTNER_KEY).update(baseString).digest('hex')
}

// ── Notificações Push (Web Push) ────────────────────────────────────
const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BO4IgKTqXnhka_IuwlscQETrwMIJlUQcSOXUzU290rkvJJslgui5UZdCTWrB-J5QEAoE0ZfXlwqfP0h5gZq1hWw'
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'aXwrRtzKNRJpFb4g-TDDmk_Kkhw0ToyA4POjhjy6y8Y'
webpush.setVapidDetails('mailto:contato@tmp10.com.br', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)

// Salva a inscrição de notificação de um usuário (chamado pelo frontend)
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const { empresa_id, user_id, subscription } = req.body
    if (!empresa_id || !user_id || !subscription?.endpoint) {
      return res.status(400).json({ error: 'Dados incompletos' })
    }
    const { error } = await sb.from('push_subscriptions').upsert({
      empresa_id,
      user_id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth
    }, { onConflict: 'endpoint' })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Remove a inscrição (quando o usuário desativa a notificação)
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body
    if (!endpoint) return res.status(400).json({ error: 'endpoint obrigatório' })
    await sb.from('push_subscriptions').delete().eq('endpoint', endpoint)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Envia notificação push pra todos os inscritos de uma empresa (usado quando o vendedor finaliza uma venda)
app.post('/api/push/notificar-venda', async (req, res) => {
  try {
    const { empresa_id, titulo, mensagem, excluir_user_id } = req.body
    if (!empresa_id) return res.status(400).json({ error: 'empresa_id obrigatório' })

    let query = sb.from('push_subscriptions').select('*').eq('empresa_id', empresa_id)
    const { data: subs, error } = await query
    if (error) return res.status(500).json({ error: error.message })

    const payload = JSON.stringify({
      title: titulo || '🔔 Nova venda!',
      body: mensagem || 'Um pedido novo foi registrado.',
      tag: 'nova-venda'
    })

    let enviados = 0
    for (const s of (subs || [])) {
      if (excluir_user_id && s.user_id === excluir_user_id) continue
      try {
        await webpush.sendNotification({
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth }
        }, payload)
        enviados++
      } catch (err) {
        // Inscrição expirada/inválida — remove do banco
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
        }
      }
    }
    res.json({ ok: true, enviados })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Manda uma notificação de aviso pra um vendedor específico ou pra todos (usado no "Avisar Vendedores")
app.post('/api/push/notificar-mensagem', async (req, res) => {
  try {
    const { empresa_id, titulo, mensagem, user_ids } = req.body
    if (!empresa_id || !mensagem) return res.status(400).json({ error: 'empresa_id e mensagem são obrigatórios' })

    let query = sb.from('push_subscriptions').select('*').eq('empresa_id', empresa_id)
    if (Array.isArray(user_ids) && user_ids.length > 0) {
      query = query.in('user_id', user_ids)
    }
    const { data: subs, error } = await query
    if (error) return res.status(500).json({ error: error.message })

    const payload = JSON.stringify({
      title: titulo || '📢 Aviso',
      body: mensagem,
      tag: 'aviso-equipe'
    })

    let enviados = 0
    for (const s of (subs || [])) {
      try {
        await webpush.sendNotification({
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth }
        }, payload)
        enviados++
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
        }
      }
    }
    res.json({ ok: true, enviados })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Auth ──────────────────────────────────────────────────────────
// state carrega "accountId:empresaId" pra sabermos, no callback, de qual
// empresa (cliente) é essa conexão — sem isso a conta ML fica sem dono.
app.get('/ml/auth/:accountId', (req, res) => {
  const empresaId = req.query.empresa_id || ''
  const redirectUri = `${RAILWAY_URL}/ml/callback`
  const state = `${req.params.accountId}:${empresaId}`
  const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${ML_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`
  res.redirect(url)
})

app.get('/ml/callback', async (req, res) => {
  const { code, state } = req.query
  const [accountId, empresaId] = String(state || '').split(':')
  try {
    const { data: tok } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'authorization_code',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      code,
      redirect_uri: `${RAILWAY_URL}/ml/callback`
    })
    const { data: userInfo } = await axios.get(
      `https://api.mercadolibre.com/users/${tok.user_id}`,
      { headers: { Authorization: `Bearer ${tok.access_token}` } }
    )
    await sb.from('ml_accounts').upsert({
      account_id: accountId,
      empresa_id: empresaId || null,
      ml_user_id: String(tok.user_id),
      nickname: userInfo.nickname,
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: new Date(Date.now() + tok.expires_in * 1000).toISOString(),
      active: true
    }, { onConflict: 'ml_user_id' })
    await syncMLOrders({ ml_user_id: String(tok.user_id), access_token: tok.access_token, nickname: userInfo.nickname, empresa_id: empresaId || null })
    res.redirect(`${ERP_URL}?ml_connected=true&nickname=${userInfo.nickname}`)
  } catch (e) {
    console.error('Auth error:', e.response?.data || e.message)
    res.redirect(`${ERP_URL}?ml_error=true`)
  }
})

// ── Shopee OAuth v2 ──────────────────────────────────────────────────
// accountId aqui é o próprio "id" (uuid) da linha em ml_accounts que foi criada manualmente
// pra essa loja — o callback atualiza essa MESMA linha com os tokens de verdade.
app.get('/shopee/auth/:accountId', (req, res) => {
  if (!SHOPEE_PARTNER_ID || !SHOPEE_PARTNER_KEY) {
    return res.status(500).send('SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY não configurados no Railway')
  }
  const empresaId = req.query.empresa_id || ''
  const path = '/api/v2/shop/auth_partner'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = shopeeSign(path, timestamp)
  const redirectBack = `${RAILWAY_URL}/shopee/callback?account_id=${req.params.accountId}&empresa_id=${empresaId}`
  const url = `${SHOPEE_HOST}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}&redirect=${encodeURIComponent(redirectBack)}`

  // ── Diagnóstico temporário (seguro — nunca loga a Partner Key em si) ──
  const baseStringDebug = `${SHOPEE_PARTNER_ID}${path}${timestamp}`
  console.log('🔎 [Shopee DEBUG] ===== /shopee/auth chamado =====')
  console.log('🔎 [Shopee DEBUG] SHOPEE_PARTNER_ID:', JSON.stringify(SHOPEE_PARTNER_ID))
  console.log('🔎 [Shopee DEBUG] SHOPEE_HOST:', JSON.stringify(SHOPEE_HOST))
  console.log('🔎 [Shopee DEBUG] path:', JSON.stringify(path))
  console.log('🔎 [Shopee DEBUG] timestamp:', timestamp)
  console.log('🔎 [Shopee DEBUG] SHOPEE_PARTNER_KEY length:', SHOPEE_PARTNER_KEY.length)
  console.log('🔎 [Shopee DEBUG] baseString:', JSON.stringify(baseStringDebug))
  console.log('🔎 [Shopee DEBUG] sign gerado:', sign)
  console.log('🔎 [Shopee DEBUG] URL final:', url)
  console.log('🔎 [Shopee DEBUG] ================================')

  res.redirect(url)
})

app.get('/shopee/callback', async (req, res) => {
  const { code, shop_id, account_id, empresa_id } = req.query
  try {
    if (!code || !shop_id) throw new Error('Shopee não devolveu code/shop_id — autorização cancelada ou incompleta')
    const path = '/api/v2/auth/token/get'
    const timestamp = Math.floor(Date.now() / 1000)
    const sign = shopeeSign(path, timestamp)
    const { data: tok } = await axios.post(
      `${SHOPEE_HOST}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`,
      { code, shop_id: Number(shop_id), partner_id: Number(SHOPEE_PARTNER_ID) }
    )
    if (tok.error) throw new Error(`${tok.error}: ${tok.message}`)

    const updatePayload = {
      platform: 'shopee',
      ml_user_id: String(shop_id),
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: new Date(Date.now() + tok.expire_in * 1000).toISOString(),
      active: true
    }
    if (account_id) {
      await sb.from('ml_accounts').update(updatePayload).eq('id', account_id)
    } else {
      await sb.from('ml_accounts').insert({ ...updatePayload, empresa_id: empresa_id || null, nickname: `Shopee ${shop_id}` })
    }
    res.redirect(`${ERP_URL}?shopee_connected=true&shop_id=${shop_id}`)
  } catch (e) {
    console.error('Shopee auth error:', e.response?.data || e.message)
    res.redirect(`${ERP_URL}?shopee_error=${encodeURIComponent(e.message)}`)
  }
})

async function refreshShopeeToken(account) {
  try {
    const path = '/api/v2/auth/access_token/get'
    const timestamp = Math.floor(Date.now() / 1000)
    const sign = shopeeSign(path, timestamp)
    const { data } = await axios.post(
      `${SHOPEE_HOST}${path}?partner_id=${SHOPEE_PARTNER_ID}&timestamp=${timestamp}&sign=${sign}`,
      { refresh_token: account.refresh_token, shop_id: Number(account.ml_user_id), partner_id: Number(SHOPEE_PARTNER_ID) }
    )
    if (data.error) throw new Error(`${data.error}: ${data.message}`)
    await sb.from('ml_accounts').update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expire_in * 1000).toISOString()
    }).eq('ml_user_id', account.ml_user_id).eq('platform', 'shopee')
    console.log(`🔑 [Shopee] Token renovado: loja ${account.ml_user_id}`)
    return data.access_token
  } catch (e) {
    console.error(`❌ [Shopee] FALHA ao renovar token da loja ${account.ml_user_id}:`, e.response?.data || e.message)
    return account.access_token
  }
}

async function getShopeeToken(account) {
  if (!account.expires_at) return account.access_token
  if (new Date(account.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    return await refreshShopeeToken(account)
  }
  return account.access_token
}

// Renova os tokens da Shopee automaticamente antes de vencerem (o access_token dura só algumas horas)
cron.schedule('*/10 * * * *', async () => {
  const { data: contas } = await sb.from('ml_accounts').select('*').eq('platform', 'shopee').eq('active', true)
  for (const acc of (contas || [])) {
    if (acc.access_token && acc.refresh_token) await getShopeeToken(acc)
  }
})

// ── Sincronização de pedidos da Shopee ──────────────────────────────
// Busca pedidos dos últimos 15 dias por vez (limite da API da Shopee), pega os detalhes em lote
// e classifica o tipo de envio: FBS (Fulfillment by Shopee) = equivalente ao FULL do ML, senão NORMAL.
// Busca os valores financeiros REAIS do pedido (comissão, taxa de serviço, frete suportado pelo vendedor, valor líquido recebido)
// Nunca inventa porcentagem fixa — usa exatamente o que a Shopee devolve pra esse pedido específico.
async function getShopeeEscrowDetail(account, orderSn, token) {
  try {
    const shopId = Number(account.ml_user_id)
    const path = '/api/v2/payment/get_escrow_detail'
    const timestamp = Math.floor(Date.now() / 1000)
    const sign = shopeeSign(path, timestamp, token, shopId)
    const { data } = await axios.get(`${SHOPEE_HOST}${path}`, {
      params: {
        partner_id: Number(SHOPEE_PARTNER_ID),
        timestamp,
        sign,
        shop_id: shopId,
        access_token: token,
        order_sn: orderSn
      }
    })
    if (data.error) {
      console.error(`[Shopee] get_escrow_detail erro (${orderSn}):`, data.error, data.message)
      return null
    }
    const inc = data.response?.order_income
    if (!inc) return null

    // Soma tudo que a Shopee de fato descontou como taxa/comissão
    const saleFee = (inc.commission_fee || 0) + (inc.service_fee || 0) + (inc.seller_transaction_fee || 0)
    // Frete que sobrou pro vendedor pagar de verdade (frete real menos o que o comprador pagou menos o subsídio da Shopee)
    const freteVendedor = Math.max(0, (inc.actual_shipping_fee || 0) - (inc.buyer_paid_shipping_fee || 0) - (inc.shopee_shipping_rebate || 0))
    // Valor líquido que realmente cai na conta do vendedor
    const valorLiquido = inc.escrow_amount != null ? inc.escrow_amount : null

    return { saleFee, freteVendedor, valorLiquido }
  } catch (e) {
    console.error(`[Shopee] Erro get_escrow_detail (${orderSn}):`, e.response?.data || e.message)
    return null
  }
}

async function syncShopeeOrders(account) {
  try {
    if (!account.access_token || !account.refresh_token) return 0
    const token = await getShopeeToken(account)
    const shopId = Number(account.ml_user_id)
    let totalNew = 0

    // A Shopee só deixa buscar 15 dias por chamada — busca em 2 janelas pra cobrir os últimos 30 dias
    const agora = Math.floor(Date.now() / 1000)
    const janelas = [
      { from: agora - 15 * 24 * 60 * 60, to: agora },
      { from: agora - 30 * 24 * 60 * 60, to: agora - 15 * 24 * 60 * 60 }
    ]

    for (const janela of janelas) {
      let cursor = ''
      let hasMore = true

      while (hasMore) {
        const path = '/api/v2/order/get_order_list'
        const timestamp = Math.floor(Date.now() / 1000)
        const sign = shopeeSign(path, timestamp, token, shopId)
        let data
        try {
          const resp = await axios.get(`${SHOPEE_HOST}${path}`, {
            params: {
              partner_id: Number(SHOPEE_PARTNER_ID),
              timestamp,
              sign,
              shop_id: shopId,
              access_token: token,
              time_range_field: 'create_time',
              time_from: janela.from,
              time_to: janela.to,
              page_size: 50,
              cursor
            }
          })
          data = resp.data
        } catch (e) {
          console.error(`[Shopee] Erro get_order_list (${account.nickname}):`, e.response?.data || e.message)
          break
        }
        if (data.error) {
          console.error(`[Shopee] get_order_list retornou erro (${account.nickname}):`, data.error, data.message)
          break
        }

        const orderList = data.response?.order_list || []
        if (orderList.length === 0) { hasMore = false; break }

        // Busca os detalhes em lote (até 50 por chamada)
        const orderSns = orderList.map(o => o.order_sn)
        const pathDetail = '/api/v2/order/get_order_detail'
        const timestampDetail = Math.floor(Date.now() / 1000)
        const signDetail = shopeeSign(pathDetail, timestampDetail, token, shopId)
        let detailData
        try {
          const respDetail = await axios.get(`${SHOPEE_HOST}${pathDetail}`, {
            params: {
              partner_id: Number(SHOPEE_PARTNER_ID),
              timestamp: timestampDetail,
              sign: signDetail,
              shop_id: shopId,
              access_token: token,
              order_sn_list: orderSns.join(','),
              response_optional_fields: 'buyer_username,item_list,total_amount,fulfillment_flag,shipping_carrier,order_status,create_time'
            }
          })
          detailData = respDetail.data
        } catch (e) {
          console.error(`[Shopee] Erro get_order_detail (${account.nickname}):`, e.response?.data || e.message)
          detailData = null
        }

        for (const order of (detailData?.response?.order_list || [])) {
          try {
            const { data: existing } = await sb.from('ml_orders')
              .select('id').eq('ml_order_id', String(order.order_sn)).maybeSingle()
            if (existing) continue

            // fulfillment_flag: 'fulfilled_by_shopee' = FBS (equivalente ao FULL do ML), o resto é envio pelo próprio vendedor
            const isFBS = order.fulfillment_flag === 'fulfilled_by_shopee'
            const orderType = isFBS ? 'FULL' : 'NORMAL'
            const status = isFBS ? 'full_ml' : 'aguardando'

            const items = (order.item_list || []).map(item => ({
              sku: item.model_sku || item.item_sku || String(item.item_id),
              name: item.item_name,
              qty: item.model_quantity_purchased || 1,
              ml_item_id: item.item_id,
              thumbnail: item.image_info?.image_url || null
            }))

            const totalAmount = order.total_amount || 0

            // Busca os valores financeiros reais desse pedido específico (comissão, taxa, frete do vendedor, valor líquido)
            const escrow = await getShopeeEscrowDetail(account, order.order_sn, token)

            const { error: insertErr } = await sb.from('ml_orders').insert({
              ml_order_id: String(order.order_sn),
              empresa_id: account.empresa_id || null,
              account_nickname: account.nickname,
              platform: 'shopee',
              buyer_name: order.buyer_username || 'Cliente',
              status,
              order_type: orderType,
              is_fulfillment: isFBS,
              items,
              ml_status: order.order_status || 'UNKNOWN',
              shipment_id: null,
              tracking_number: null,
              created_at_ml: order.create_time ? new Date(order.create_time * 1000).toISOString() : new Date().toISOString(),
              total_amount: totalAmount,
              paid_amount: escrow?.valorLiquido != null ? escrow.valorLiquido : totalAmount,
              sale_fee: escrow?.saleFee || 0,
              shipping_cost_ml: escrow?.freteVendedor || 0,
              taxes_amount: 0 // imposto continua sendo configuração interna do TMP10, não vem da Shopee
            })

            // Se realmente inseriu agora (não era duplicado por uma corrida entre sincronizações),
            // desconta o estoque central na hora — não espera o próximo ciclo.
            // Pedidos FULL (fulfillment da própria Shopee) não descontam daqui, porque esse estoque já
            // fica fisicamente no centro de distribuição da Shopee, fora do controle do TMP10.
            if (!insertErr && !isFBS) {
              await processarBaixaEstoque(items, account.empresa_id, account, 'shopee')
            }

            // Auto cadastra produto (só os que o vendedor mesmo envia, igual já fazemos no ML)
            if (!isFBS) {
              for (const item of items) {
                if (item.sku) {
                  await sb.from('products').upsert({
                    sku: String(item.sku),
                    empresa_id: account.empresa_id || null,
                    name: item.name,
                    description: `Shopee - ${account.nickname}`,
                    photo: item.thumbnail || null,
                    active: true,
                    source: 'shopee'
                  }, { onConflict: 'sku', ignoreDuplicates: true })
                }
              }
            }
            totalNew++
          } catch (orderErr) {
            console.error(`  ⚠️ [Shopee] Pedido ${order.order_sn} falhou (${account.nickname}): ${orderErr.message}`)
          }
        }

        cursor = data.response?.next_cursor || ''
        hasMore = data.response?.more === true && !!cursor
        if (hasMore) await new Promise(r => setTimeout(r, 400)) // evita bater no limite de requisições da Shopee
      }
    }

    if (totalNew > 0) console.log(`✅ [Shopee] ${account.nickname}: ${totalNew} novos pedidos`)
    return totalNew
  } catch (e) {
    console.error(`[Shopee] Sync error (${account.nickname}):`, e.response?.data || e.message)
    return 0
  }
}

// ── Token ─────────────────────────────────────────────────────────
async function refreshToken(account) {
  try {
    const { data } = await axios.post('https://api.mercadolibre.com/oauth/token', {
      grant_type: 'refresh_token',
      client_id: ML_CLIENT_ID,
      client_secret: ML_CLIENT_SECRET,
      refresh_token: account.refresh_token
    })
    await sb.from('ml_accounts').update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString()
    }).eq('ml_user_id', account.ml_user_id)
    console.log(`🔑 Token renovado com sucesso: ${account.nickname}`)
    return data.access_token
  } catch (e) {
    console.error(`❌ FALHA ao renovar token de ${account.nickname}: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`)
    return account.access_token
  }
}

async function getToken(account) {
  if (!account.expires_at) return account.access_token
  if (new Date(account.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    return await refreshToken(account)
  }
  return account.access_token
}

// ── Detectar tipo via /shipments/{id} ─────────────────────────────
function isFulfillment(shipment) {
  const logistic = (shipment?.logistic_type || '').toLowerCase()
  const tags     = shipment?.tags || []
  if (logistic === 'fulfillment') return true
  if (tags.includes('meli_fulfillment')) return true
  return false
}

async function detectOrderType(order, token) {
  const tags = order.tags || []
  const shippingLogistic = (order.shipping?.logistic_type || '').toLowerCase()

  if (tags.includes('meli_fulfillment')) return 'FULL'
  if (shippingLogistic === 'fulfillment') return 'FULL'
  if (shippingLogistic === 'self_service') return 'FLEX'
  if (shippingLogistic === 'drop_off') return 'NORMAL'

  const shipmentId = order.shipping?.id
  if (shipmentId && token) {
    try {
      const { data: shipment } = await axios.get(
        `https://api.mercadolibre.com/shipments/${shipmentId}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      )
      const logistic = (shipment.logistic_type || '').toLowerCase()
      console.log(`  Shipment ${shipmentId}: logistic=${logistic} tags=${(shipment.tags||[]).join(',')}`)
      if (isFulfillment(shipment)) return 'FULL'
      if (logistic === 'self_service') return 'FLEX'
      return 'NORMAL'
    } catch (e) {
      console.log(`  Shipment ${shipmentId} lookup failed: ${e.message}`)
    }
  }
  return 'NORMAL'
}

// ── CORREÇÃO v9.0: Buscar custos reais via /orders/{id}/billing_info ──────────
// A API do ML tem um endpoint específico que retorna exatamente o que aparece
// no extrato do vendedor: comissão real, frete real, descontos/bônus de campanha
async function calcCustosReaisML(mlOrderId, token) {
  if (!mlOrderId || !token) return { saleFeeLiquido: 0, freteVendedor: 0, bonusCampanha: 0 }
  try {
    const { data } = await axios.get(
      `https://api.mercadolibre.com/orders/${mlOrderId}/billing_info`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    )

    let saleFeeLiquido = 0
    let freteVendedor = 0
    let bonusCampanha = 0

    const items = data?.items || []
    for (const item of items) {
      const tipo = (item.type || '').toLowerCase()
      const subtipo = (item.subtype || '').toLowerCase()
      const valor = Math.abs(item.amount || 0)

      if (tipo === 'market_fee' || subtipo === 'sale_fee') {
        saleFeeLiquido += valor
      } else if (tipo === 'shipping' || subtipo === 'shipping') {
        if ((item.amount || 0) < 0) {
          freteVendedor += valor // custo para o vendedor (negativo = saída)
        }
      } else if (tipo === 'discount' || subtipo === 'campaign') {
        bonusCampanha += valor // bônus/desconto que o ML devolve
      }
    }

    console.log(`  billing_info ${mlOrderId}: fee=${saleFeeLiquido} frete=${freteVendedor} bonus=${bonusCampanha}`)
    return { saleFeeLiquido, freteVendedor, bonusCampanha }
  } catch (e) {
    console.log(`  billing_info falhou ${mlOrderId}: ${e.message}`)
    // Fallback: calcula pelo paid_amount
    return null
  }
}

// ── Calcular custos via paid_amount (fallback) ─────────────────────
// paid_amount da API do ML = total_amount - comissao - frete + bonus
// Então: total_amount - paid_amount = custos_liquidos_totais
async function calcCustosFallback(order, token) {
  const totalAmount = order.total_amount || 0
  const paidAmountML = order.payments?.[0]?.total_paid_amount || 
                       order.paid_amount || 0

  // Custo total líquido = o que o ML descontou
  const custoTotal = totalAmount - paidAmountML

  // sale_fee da API (soma de todos os itens)
  const saleFeeTot = order.order_items?.reduce((s,i) => s + (i.sale_fee || 0), 0) || 0

  // Frete = custo total - comissão (pode incluir bônus)
  const freteVendedor = Math.max(0, custoTotal - saleFeeTot)

  return { saleFeeLiquido: saleFeeTot, freteVendedor, bonusCampanha: 0 }
}

// ── Estoque Central TMP10 ────────────────────────────────────────────
// O TMP10 é a fonte da verdade do estoque. Toda vez que um pedido novo entra
// (ML ou Shopee), desconta na hora (sem esperar o próximo ciclo) e avisa as duas plataformas.

// Desconto atômico — usa a função do banco (decrementar_estoque_central), que trava a linha
// durante a operação, então duas vendas simultâneas do último item nunca deixam o estoque negativo.
async function descontarEstoqueCentral(sku, empresaId, quantidade) {
  if (!sku || !empresaId) return null
  try {
    const { data, error } = await sb.rpc('decrementar_estoque_central', {
      p_sku: sku,
      p_empresa_id: empresaId,
      p_quantidade: quantidade
    })
    if (error) {
      console.error(`[Estoque] Erro ao descontar SKU ${sku}:`, error.message)
      return null
    }
    return data // novo estoque, já atualizado
  } catch (e) {
    console.error(`[Estoque] Erro ao descontar SKU ${sku}:`, e.message)
    return null
  }
}

// Avisa o Mercado Livre do novo estoque, usando o vínculo já existente (product_ml_links)
async function pushEstoqueParaML(sku, empresaId, novoEstoque, account) {
  try {
    const { data: link } = await sb.from('product_ml_links')
      .select('*').eq('sku', sku).eq('empresa_id', empresaId).maybeSingle()
    if (!link?.item_id) return // produto ainda não tá vinculado a um anúncio do ML, não tem pra onde mandar
    const token = await getToken(account)
    if (!token) return
    await axios.put(
      `https://api.mercadolibre.com/items/${link.item_id}`,
      { available_quantity: novoEstoque },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
    )
  } catch (e) {
    console.error(`[Estoque→ML] Erro ao empurrar estoque do SKU ${sku}:`, e.response?.data || e.message)
  }
}

// Avisa a Shopee do novo estoque, usando o vínculo (product_shopee_links)
async function pushEstoqueParaShopee(sku, empresaId, novoEstoque, account) {
  try {
    const { data: link } = await sb.from('product_shopee_links')
      .select('*').eq('sku', sku).eq('empresa_id', empresaId).maybeSingle()
    if (!link?.item_id) return // produto ainda não tá vinculado a um anúncio da Shopee
    const token = await getShopeeToken(account)
    if (!token) return
    const shopId = Number(account.ml_user_id)
    const path = '/api/v2/product/update_stock'
    const timestamp = Math.floor(Date.now() / 1000)
    const sign = shopeeSign(path, timestamp, token, shopId)
    const stockList = link.model_id
      ? [{ model_id: link.model_id, seller_stock: [{ stock: novoEstoque }] }]
      : [{ seller_stock: [{ stock: novoEstoque }] }]
    await axios.post(`${SHOPEE_HOST}${path}`, {
      partner_id: Number(SHOPEE_PARTNER_ID),
      shop_id: shopId,
      timestamp,
      access_token: token,
      item_id: link.item_id,
      stock_list: stockList
    }, { params: { partner_id: Number(SHOPEE_PARTNER_ID), timestamp, sign, shop_id: shopId, access_token: token } })
  } catch (e) {
    console.error(`[Estoque→Shopee] Erro ao empurrar estoque do SKU ${sku}:`, e.response?.data || e.message)
  }
}

// Função única chamada sempre que um pedido novo (de qualquer plataforma) é gravado —
// desconta o estoque central de cada item vendido e já avisa as duas plataformas.
async function processarBaixaEstoque(items, empresaId, contaOrigem, plataformaOrigem) {
  for (const item of (items || [])) {
    if (!item.sku) continue
    const qtd = item.qty || 1
    const novoEstoque = await descontarEstoqueCentral(item.sku, empresaId, qtd)
    if (novoEstoque == null) continue
    // Avisa as duas plataformas em paralelo — não trava uma esperando a outra
    const { data: contasAtivas } = await sb.from('ml_accounts').select('*').eq('empresa_id', empresaId).eq('active', true)
    await Promise.all((contasAtivas || []).map(acc => {
      if (acc.platform === 'shopee') return pushEstoqueParaShopee(item.sku, empresaId, novoEstoque, acc)
      return pushEstoqueParaML(item.sku, empresaId, novoEstoque, acc)
    }))
  }
}

// ── Sync ──────────────────────────────────────────────────────────
async function syncMLOrders(account) {
  try {
    const token = await getToken(account)
    let totalNew = 0

    const dateFrom = new Date()
    dateFrom.setDate(dateFrom.getDate() - 30)
    const dateFromStr = dateFrom.toISOString().slice(0, 19) + '.000-00:00'

    for (const mlStatus of ['paid', 'payment_in_process']) {
      let offset = 0
      let hasMore = true

      while (hasMore) {
        try {
          if (offset > 0) await new Promise(r => setTimeout(r, 400)); // evita bater no limite de requisições do ML
          let data;
          try {
            ({ data } = await axios.get(
              `https://api.mercadolibre.com/orders/search?seller=${account.ml_user_id}&order.status=${mlStatus}&order.date_created.from=${encodeURIComponent(dateFromStr)}&sort=date_desc&limit=50&offset=${offset}`,
              { headers: { Authorization: `Bearer ${token}` } }
            ))
          } catch (e429) {
            if (e429.response?.status === 429) {
              // Limite de requisições do ML — espera um pouco e tenta mais uma vez antes de desistir
              await new Promise(r => setTimeout(r, 2000));
              ({ data } = await axios.get(
                `https://api.mercadolibre.com/orders/search?seller=${account.ml_user_id}&order.status=${mlStatus}&order.date_created.from=${encodeURIComponent(dateFromStr)}&sort=date_desc&limit=50&offset=${offset}`,
                { headers: { Authorization: `Bearer ${token}` } }
              ))
            } else {
              throw e429;
            }
          }

          const results = data.results || []
          const total = data.paging?.total || 0

          for (const order of results) {
            try {
              const { data: existing } = await sb.from('ml_orders')
                .select('id').eq('ml_order_id', String(order.id)).maybeSingle()
              if (existing) continue

              const orderType = await detectOrderType(order, token)
              const isFull = orderType === 'FULL'
              const status = isFull ? 'full_ml' : 'aguardando'

              const items = order.order_items.map(item => ({
                sku: item.item.seller_sku || item.item.id,
                name: item.item.title,
                qty: item.quantity,
                ml_item_id: item.item.id,
                thumbnail: item.item.thumbnail
              }))

              // ✅ v9.5: totalAmount declarado corretamente
              const totalAmount = order.total_amount || 0
              const saleFeeTot = order.order_items?.reduce((s,i) => s + (i.sale_fee || 0), 0) || 0
              const taxesAmount = order.taxes?.amount || 0
              const shipmentId = order.shipping?.id ? String(order.shipping.id) : null

              // Busca frete real do shipment (e o código de rastreio pra bipagem)
              let freteVendedor = 0
              let trackingNumber = null
              if (shipmentId && token) {
                try {
                  const { data: shipData } = await axios.get(
                    `https://api.mercadolibre.com/shipments/${shipmentId}`,
                    { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
                  )
                  // list_cost = custo total do frete cobrado do vendedor
                  freteVendedor = shipData.shipping_option?.list_cost || shipData.cost?.sender?.cost || 0
                  trackingNumber = shipData.tracking_number || null
                  console.log(`  Frete shipment ${shipmentId}: ${freteVendedor} | rastreio: ${trackingNumber}`)
                } catch(e) {
                  console.log(`  Erro frete ${shipmentId}: ${e.message}`)
                }
              }

              const saleFeeLiquido = saleFeeTot
              const paidAmount = totalAmount - saleFeeLiquido - freteVendedor

              const { error: insertErrML } = await sb.from('ml_orders').insert({
                ml_order_id: String(order.id),
                empresa_id: account.empresa_id || null,
                account_nickname: account.nickname,
                buyer_name: order.buyer?.nickname || order.buyer?.full_name || 'Cliente',
                status,
                order_type: orderType,
                is_fulfillment: isFull,
                items,
                ml_status: mlStatus,
                shipment_id: shipmentId,
                tracking_number: trackingNumber,
                created_at_ml: order.date_created,
                total_amount: totalAmount,
                paid_amount: paidAmount,
                sale_fee: saleFeeLiquido,
                shipping_cost_ml: freteVendedor,
                taxes_amount: taxesAmount
              })

              // Se realmente inseriu agora (não era duplicado), desconta o estoque central na hora.
              // Pedidos FULL (fulfillment do próprio ML) não descontam daqui — o estoque físico já está
              // no centro de distribuição do ML, fora do controle direto do TMP10.
              if (!insertErrML && !isFull) {
                await processarBaixaEstoque(items, account.empresa_id, account, 'mercadolivre')
              }

              // Auto cadastra produto (apenas nao-FULL)
              if (!isFull) {
                for (const item of items) {
                  if (item.sku) {
                    await sb.from('products').upsert({
                      sku: String(item.sku),
                      empresa_id: account.empresa_id || null,
                      name: item.name,
                      description: `ML - ${account.nickname}`,
                      photo: item.thumbnail ? item.thumbnail.replace('-I.jpg', '-O.jpg').replace('http://', 'https://') : null,
                      active: true,
                      source: 'mercadolivre'
                    }, { onConflict: 'sku', ignoreDuplicates: true })
                  }
                }
              }
              totalNew++
            } catch (orderErr) {
              // Um pedido com problema não pode derrubar o lote inteiro — loga e segue pro próximo
              console.error(`  ⚠️ Pedido ${order.id} falhou (${account.nickname}): ${orderErr.message}`)
            }
          }

          if (results.length < 50 || offset + 50 >= total) {
            hasMore = false
          } else {
            offset += 50
            if (offset >= 500) hasMore = false
          }
        } catch (e) {
          console.error(`Erro offset=${offset}:`, e.message)
          hasMore = false
        }
      }
    }

    if (totalNew > 0) console.log(`✅ ${account.nickname}: ${totalNew} novos pedidos`)
    return totalNew
  } catch (e) {
    console.error(`Sync error (${account.nickname}):`, e.response?.data || e.message)
    return 0
  }
}

async function syncAll() {
  const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
  if (!accounts?.length) return
  for (const acc of accounts) {
    if (acc.platform === 'shopee') {
      await syncShopeeOrders(acc)
    } else {
      await syncMLOrders(acc)
    }
  }
}

// ── Reclassificar pedidos ─────────────────────────────────────────
async function reclassifyOrders() {
  const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
  if (!accounts?.length) return

  const { data: orders } = await sb.from('ml_orders')
    .select('id, ml_order_id, shipment_id, order_type, status')
    .in('status', ['aguardando', 'separando', 'conferindo', 'full_ml'])
    .not('shipment_id', 'is', null)
    .limit(100)

  if (!orders?.length) return

  const account = accounts[0]
  const token = await getToken(account)
  let fixed = 0

  for (const order of orders) {
    try {
      const { data: shipment } = await axios.get(
        `https://api.mercadolibre.com/shipments/${order.shipment_id}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      )

      const logistic = (shipment.logistic_type || '').toLowerCase()
      let correctType = 'NORMAL'
      if (isFulfillment(shipment)) correctType = 'FULL'
      else if (logistic === 'self_service') correctType = 'FLEX'

      if (correctType !== order.order_type) {
        const newStatus = correctType === 'FULL' ? 'full_ml' : 'aguardando'
        await sb.from('ml_orders').update({
          order_type: correctType,
          is_fulfillment: correctType === 'FULL',
          status: newStatus,
          updated_at: new Date().toISOString()
        }).eq('id', order.id)
        fixed++
        console.log(`🔄 Reclassificado ${order.ml_order_id}: ${order.order_type} -> ${correctType}`)
      }
    } catch (e) {}
  }

  if (fixed > 0) console.log(`✅ Reclassificados ${fixed} pedidos`)
}

// ── Verificar entregas ────────────────────────────────────────────
async function checkDeliveries() {
  const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
  if (!accounts?.length) return

  const { data: orders } = await sb.from('ml_orders')
    .select('id, ml_order_id, shipment_id, status, order_type, tracking_number')
    .in('status', ['embalado', 'aguardando', 'separando', 'conferindo', 'full_ml'])
    .not('shipment_id', 'is', null)
    .limit(100)

  if (!orders?.length) return

  const account = accounts[0]
  const token = await getToken(account)
  let delivered = 0

  for (const order of orders) {
    try {
      const { data: shipment } = await axios.get(
        `https://api.mercadolibre.com/shipments/${order.shipment_id}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      )

      const shipStatus = (shipment.status || '').toLowerCase()
      const entregue = ['delivered', 'delivered_to_neighbor'].includes(shipStatus)

      if (entregue && order.status !== 'finalizado') {
        await sb.from('ml_orders').update({
          status: 'finalizado',
          tracking_number: shipment.tracking_number || order.tracking_number || null,
          updated_at: new Date().toISOString()
        }).eq('id', order.id)
        delivered++
        console.log(`📦 Entregue: ${order.ml_order_id}`)
      }

      if (!order.tracking_number && shipment.tracking_number) {
        await sb.from('ml_orders').update({
          tracking_number: shipment.tracking_number,
          updated_at: new Date().toISOString()
        }).eq('id', order.id)
      }
    } catch (e) {}
  }

  if (delivered > 0) console.log(`✅ ${delivered} pedidos finalizados`)
}

// ── Sync Perguntas ML ─────────────────────────────────────────────
async function syncPerguntas() {
  try {
    const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
    if (!accounts?.length) return
    let total = 0
    for (const account of accounts) {
      const token = await getToken(account)
      if (!token) continue
      try {
        const { data: resp } = await axios.get(
          `https://api.mercadolibre.com/questions/search?seller_id=${account.ml_user_id}&status=UNANSWERED&limit=20`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
        )
        const perguntas = resp?.questions || []
        for (const p of perguntas) {
          const { data: item } = await axios.get(
            `https://api.mercadolibre.com/items/${p.item_id}?attributes=title`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
          ).catch(() => ({ data: null }))

          await sb.from('ml_perguntas').upsert({
            pergunta_id: String(p.id),
            account_nickname: account.nickname,
            comprador: p.from?.nickname || 'Cliente',
            texto: p.text,
            item_id: p.item_id,
            item_titulo: item?.title || p.item_id,
            status: 'pendente',
            created_at: p.date_created,
            synced_at: new Date().toISOString()
          }, { onConflict: 'pergunta_id', ignoreDuplicates: false })
          total++
        }
      } catch (e) {
        console.log(`Erro perguntas ${account.nickname}: ${e.message}`)
      }
    }
    if (total > 0) console.log(`💬 ${total} perguntas sincronizadas`)
  } catch (e) {
    console.log('Erro sync perguntas:', e.message)
  }
}

// ── Sync Estoque ML (multi-conta, somado por empresa+SKU) ─────────
// Relê a quantidade de cada anúncio já vinculado em product_ml_links
// (usando o token da conta dona do anúncio) e depois soma tudo por
// empresa_id+sku, gravando o total em products.estoque_atual.
async function syncEstoqueML() {
  try {
    const { data: links } = await sb.from('product_ml_links').select('*')
    if (!links?.length) {
      console.log('ℹ️ Nenhum anúncio vinculado ainda em product_ml_links (rode "Importar Produtos do ML")')
      return
    }
    const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
    const accByNick = {}
    for (const acc of accounts || []) accByNick[acc.nickname] = acc

    const byAccount = {}
    for (const link of links) {
      if (!byAccount[link.account_nickname]) byAccount[link.account_nickname] = []
      byAccount[link.account_nickname].push(link)
    }

    for (const [nickname, accLinks] of Object.entries(byAccount)) {
      const account = accByNick[nickname]
      if (!account) continue
      const token = await getToken(account)
      if (!token) continue

      for (let i = 0; i < accLinks.length; i += 20) {
        const batch = accLinks.slice(i, i + 20)
        const ids = batch.map(l => l.ml_item_id).join(',')
        try {
          const { data } = await axios.get(
            `https://api.mercadolibre.com/items?ids=${ids}`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 }
          )
          for (const entry of data || []) {
            if (entry.code !== 200) continue
            const item = entry.body
            const link = batch.find(l => l.ml_item_id === String(item.id))
            if (!link) continue
            await sb.from('product_ml_links')
              .update({ quantity: item.available_quantity || 0, updated_at: new Date().toISOString() })
              .eq('id', link.id)
          }
        } catch (e) {
          console.log(`Erro estoque lote (${nickname}): ${e.message}`)
        }
        await new Promise(r => setTimeout(r, 300))
      }
    }

    const { data: fresh } = await sb.from('product_ml_links').select('empresa_id,sku,quantity')
    const totals = {}
    for (const l of fresh || []) {
      const key = `${l.empresa_id}::${l.sku}`
      totals[key] = (totals[key] || 0) + (l.quantity || 0)
    }
    // Não sobrescreve mais o estoque central — o TMP10 é quem manda agora.
    // Só compara com o que o ML está mostrando e registra um alerta se tiver diferença,
    // pra dar pra investigar (produto vendido fora do sistema, ajuste manual no ML, etc).
    let divergenciasEncontradas = 0
    for (const [key, totalML] of Object.entries(totals)) {
      const [empresa_id, sku] = key.split('::')
      const { data: produtoAtual } = await sb.from('products')
        .select('estoque_atual').eq('empresa_id', empresa_id).eq('sku', sku).maybeSingle()
      if (!produtoAtual) continue
      const estoqueTMP10 = produtoAtual.estoque_atual || 0
      if (estoqueTMP10 !== totalML) {
        await sb.from('estoque_divergencias').insert({
          empresa_id,
          sku,
          estoque_tmp10: estoqueTMP10,
          estoque_ml: totalML,
          diferenca: totalML - estoqueTMP10
        })
        divergenciasEncontradas++
      }
    }

    console.log(`✅ Sync estoque ML concluído (${links.length} anúncios verificados${divergenciasEncontradas > 0 ? `, ⚠️ ${divergenciasEncontradas} divergência(s) encontrada(s)` : ', nenhuma divergência'})`)
  } catch (e) {
    console.log('Erro sync estoque:', e.message)
  }
}

// ── Crons ─────────────────────────────────────────────────────────
cron.schedule('*/2 * * * *', syncAll)
cron.schedule('*/30 * * * *', syncEstoqueML)
cron.schedule('*/15 * * * *', checkDeliveries)
cron.schedule('*/5 * * * *', syncPerguntas)
cron.schedule('*/10 * * * *', recalcularPedidosRecentesAutomatico)

// ── Webhook ML ────────────────────────────────────────────────────
app.post('/ml/notifications', async (req, res) => {
  res.status(200).json({ ok: true })
  try {
    const { resource, topic, user_id } = req.body
    if (topic !== 'shipments' && topic !== 'orders_v2') return
    const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
    if (!accounts?.length) return
    const account = accounts.find(a => String(a.ml_user_id) === String(user_id)) || accounts[0]
    const token = await getToken(account)

    if (topic === 'shipments' && resource) {
      const shipmentId = resource.split('/').pop()
      if (!shipmentId) return
      const { data: shipment } = await axios.get(
        `https://api.mercadolibre.com/shipments/${shipmentId}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      )
      if ((shipment.status || '').toLowerCase() === 'delivered') {
        const { data: order } = await sb.from('ml_orders')
          .select('id, ml_order_id, status')
          .eq('shipment_id', String(shipmentId))
          .maybeSingle()
        if (order && order.status !== 'finalizado') {
          await sb.from('ml_orders').update({
            status: 'finalizado',
            tracking_number: shipment.tracking_number || null,
            updated_at: new Date().toISOString()
          }).eq('id', order.id)
          console.log(`🎉 Webhook: pedido ${order.ml_order_id} finalizado`)
        }
      }
    }

    if (topic === 'orders_v2' && resource) {
      const orderId = resource.split('/').pop()
      const { data: mlOrder } = await axios.get(
        `https://api.mercadolibre.com/orders/${orderId}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
      )
      if (mlOrder.status === 'cancelled') {
        const { data: order } = await sb.from('ml_orders')
          .select('id, status')
          .eq('ml_order_id', String(orderId))
          .maybeSingle()
        if (order && !['finalizado', 'cancelado'].includes(order.status)) {
          await sb.from('ml_orders').update({
            status: 'cancelado',
            updated_at: new Date().toISOString()
          }).eq('id', order.id)
        }
      }
    }
  } catch (e) {
    console.error('Webhook error:', e.message)
  }
})

// ── Endpoints ─────────────────────────────────────────────────────
app.post('/api/sync-perguntas', async (req, res) => {
  res.json({ ok: true })
  syncPerguntas()
})

app.post('/api/pergunta-respondida/:id', async (req, res) => {
  await sb.from('ml_perguntas').update({
    status: 'respondido',
    respondido_at: new Date().toISOString()
  }).eq('pergunta_id', req.params.id)
  res.json({ ok: true })
})

app.post('/api/check-deliveries', async (req, res) => {
  await checkDeliveries()
  res.json({ ok: true })
})

app.post('/api/sync-estoque', async (req, res) => {
  res.json({ ok: true })
  syncEstoqueML()
})

// ✅ v9.0: Recalcular custos usando billing_info (correto) + fallback paid_amount
// Recalcula automaticamente pedidos recentes que sincronizaram com taxa zerada
// (comum: ML ainda não tinha fechado a comissão no momento da sincronização inicial)
async function recalcularPedidosRecentesAutomatico() {
  try {
    const desde = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString() // últimas 12h
    const { data: orders } = await sb.from('ml_orders')
      .select('id, ml_order_id, shipment_id, sale_fee, total_amount, account_nickname, tracking_number')
      .eq('sale_fee', 0)
      .gt('created_at_ml', desde)
      .not('status', 'in', '(cancelado)')
      .limit(50)

    if (!orders?.length) return

    const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
    const tokenMap = {}
    for (const acc of accounts || []) tokenMap[acc.nickname] = await getToken(acc)

    let corrigidos = 0
    for (const order of orders) {
      try {
        const orderToken = tokenMap[order.account_nickname]
        if (!orderToken) continue

        const { data: mlOrder } = await axios.get(
          `https://api.mercadolibre.com/orders/${order.ml_order_id}`,
          { headers: { Authorization: `Bearer ${orderToken}` }, timeout: 8000 }
        )
        const saleFeeTot = mlOrder.order_items?.reduce((s,i) => s + (i.sale_fee || 0), 0) || 0
        if (saleFeeTot === 0) continue // ML ainda não fechou, tenta de novo no próximo ciclo

        const totalAmount = mlOrder.total_amount || order.total_amount
        const taxesAmount = mlOrder.taxes?.amount || 0

        let freteVendedor = 0
        let trackingNumber = order.tracking_number
        if (order.shipment_id) {
          try {
            const { data: shipData } = await axios.get(
              `https://api.mercadolibre.com/shipments/${order.shipment_id}`,
              { headers: { Authorization: `Bearer ${orderToken}` }, timeout: 5000 }
            )
            freteVendedor = shipData.shipping_option?.list_cost || shipData.cost?.sender?.cost || 0
            trackingNumber = shipData.tracking_number || trackingNumber
          } catch(e) {}
        }

        await sb.from('ml_orders').update({
          sale_fee: saleFeeTot,
          shipping_cost_ml: freteVendedor,
          paid_amount: totalAmount - saleFeeTot - freteVendedor,
          taxes_amount: taxesAmount,
          total_amount: totalAmount,
          tracking_number: trackingNumber
        }).eq('id', order.id)
        corrigidos++
        await new Promise(r => setTimeout(r, 400))
      } catch (e) {
        console.log(`  Erro recalc automático ${order.ml_order_id}: ${e.message}`)
      }
    }
    if (corrigidos > 0) console.log(`💰 ${corrigidos} pedido(s) tiveram taxa/frete/rastreio corrigidos automaticamente`)
  } catch (e) {
    console.log('Erro recalcularPedidosRecentesAutomatico:', e.message)
  }
}

app.post('/api/recalcular-custos', async (req, res) => {
  const offset = parseInt(req.query.offset || '0')
  const limit = 30
  res.json({ ok: true, message: `Recalculando custos v9 (offset=${offset})...` })
  ;(async () => {
    const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
    if (!accounts?.length) return

    // ✅ v9.4: Mapeia token por nickname de conta
    const tokenMap = {}
    for (const acc of accounts) {
      tokenMap[acc.nickname] = await getToken(acc)
    }
    const tokenDefault = tokenMap[accounts[0].nickname]

    const { data: orders } = await sb.from('ml_orders')
      .select('id, ml_order_id, shipment_id, sale_fee, shipping_cost_ml, total_amount, paid_amount, account_nickname')
      .not('status', 'in', '(cancelado)')
      .order('created_at_ml', { ascending: false })
      .range(offset, offset + limit - 1)

    if (!orders?.length) {
      console.log('✅ Nenhum pedido para recalcular neste offset')
      return
    }

    console.log(`🔄 Recalculando ${orders.length} pedidos (offset=${offset})`)
    let fixed = 0

    for (const order of orders) {
      try {
        // Usa token da conta correta para cada pedido
        const orderToken = tokenMap[order.account_nickname] || tokenDefault

        // Busca dados atualizados do ML
        const { data: mlOrder } = await axios.get(
          `https://api.mercadolibre.com/orders/${order.ml_order_id}`,
          { headers: { Authorization: `Bearer ${orderToken}` }, timeout: 8000 }
        )
        const totalAmount = mlOrder.total_amount || order.total_amount
        const saleFeeTot = mlOrder.order_items?.reduce((s,i) => s + (i.sale_fee || 0), 0) || order.sale_fee || 0
        const taxesAmountNew = mlOrder.taxes?.amount || 0

        // ✅ v9.4: Busca frete com token correto da conta
        let freteVendedor = 0
        const shipmentIdRecalc = order.shipment_id
        if (shipmentIdRecalc) {
          try {
            const { data: shipData } = await axios.get(
              `https://api.mercadolibre.com/shipments/${shipmentIdRecalc}`,
              { headers: { Authorization: `Bearer ${orderToken}` }, timeout: 5000 }
            )
            freteVendedor = shipData.shipping_option?.list_cost || shipData.cost?.sender?.cost || 0
            console.log(`  Frete recalc ${order.account_nickname} ${shipmentIdRecalc}: ${freteVendedor}`)
          } catch(e) {
            console.log(`  Erro frete recalc ${shipmentIdRecalc}: ${e.message}`)
          }
        }

        const saleFeeLiquido = saleFeeTot
        const paidAmount = totalAmount - saleFeeLiquido - freteVendedor
        const taxesAmount = mlOrder.taxes?.amount || 0

        await sb.from('ml_orders').update({
          sale_fee: saleFeeLiquido,
          shipping_cost_ml: freteVendedor,
          paid_amount: paidAmount,
          taxes_amount: taxesAmount,
          total_amount: totalAmount,
          updated_at: new Date().toISOString()
        }).eq('id', order.id)
        fixed++
        console.log(`✅ ${order.ml_order_id}: fee=${saleFeeLiquido} frete=${freteVendedor} paid=${paidAmount}`)
        await new Promise(r => setTimeout(r, 600))
      } catch (e) {
        console.log(`❌ Erro em ${order.ml_order_id}: ${e.message}`)
      }
    }
    console.log(`✅ Recalculado: ${fixed}/${orders.length} pedidos (offset=${offset})`)
  })()
})

app.post('/api/reclassify', async (req, res) => {
  await reclassifyOrders()
  res.json({ ok: true })
})

app.post('/api/reclassify-all', async (req, res) => {
  res.json({ ok: true, message: 'Reclassificação em massa iniciada...' })
  ;(async () => {
    const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)
    if (!accounts?.length) return
    const { data: orders } = await sb.from('ml_orders')
      .select('id, ml_order_id, shipment_id, order_type, status')
      .in('status', ['aguardando', 'separando', 'conferindo', 'full_ml', 'embalado'])
      .not('shipment_id', 'is', null)
    if (!orders?.length) return
    const token = await getToken(accounts[0])
    let fixed = 0
    for (const order of orders) {
      try {
        const { data: shipment } = await axios.get(
          `https://api.mercadolibre.com/shipments/${order.shipment_id}`,
          { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
        )
        const logistic = (shipment.logistic_type || '').toLowerCase()
        let correctType = 'NORMAL'
        if (isFulfillment(shipment)) correctType = 'FULL'
        else if (logistic === 'self_service') correctType = 'FLEX'
        if (correctType !== order.order_type) {
          await sb.from('ml_orders').update({
            order_type: correctType,
            is_fulfillment: correctType === 'FULL',
            status: correctType === 'FULL' ? 'full_ml' : 'aguardando',
            updated_at: new Date().toISOString()
          }).eq('id', order.id)
          fixed++
        }
        await new Promise(r => setTimeout(r, 200))
      } catch (e) {}
    }
    console.log(`✅ Reclassificação: ${fixed} corrigidos de ${orders.length}`)
  })()
})

let backfillStatus = { running: false, corrigidos: 0, erros: 0, total: 0, terminadoEm: null }

async function rodarBackfillTracking() {
  backfillStatus = { running: true, corrigidos: 0, erros: 0, total: 0, terminadoEm: null }
  try {
    const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true)

    for (const account of accounts || []) {
      const token = await getToken(account)
      const { data: orders } = await sb.from('ml_orders')
        .select('id, shipment_id')
        .eq('empresa_id', account.empresa_id)
        .is('tracking_number', null)
        .not('shipment_id', 'is', null)
        .limit(500)

      backfillStatus.total += (orders || []).length

      for (const order of orders || []) {
        try {
          const { data: shipData } = await axios.get(
            `https://api.mercadolibre.com/shipments/${order.shipment_id}`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 5000 }
          )
          if (shipData.tracking_number) {
            await sb.from('ml_orders').update({ tracking_number: shipData.tracking_number }).eq('id', order.id)
            backfillStatus.corrigidos++
          }
        } catch (e) {
          backfillStatus.erros++
        }
      }
    }
  } catch (e) {
    console.log('Erro no backfill:', e.message)
  } finally {
    backfillStatus.running = false
    backfillStatus.terminadoEm = new Date().toISOString()
  }
}

app.all('/api/backfill-tracking', (req, res) => {
  if (backfillStatus.running) {
    return res.json({ ok: true, message: 'Já está rodando, confere o progresso em /api/backfill-tracking/status', status: backfillStatus })
  }
  rodarBackfillTracking() // não aguarda — roda em segundo plano
  res.json({ ok: true, message: 'Iniciado em segundo plano. Confere o progresso em /api/backfill-tracking/status' })
})

app.get('/api/backfill-tracking/status', (req, res) => {
  res.json(backfillStatus)
})

app.get('/', (req, res) => res.json({
  status: '🚀 TMP10 Backend v9.5 — bugs sync corrigidos',
  uptime: Math.floor(process.uptime()) + 's',
  sync_interval: '2 minutos',
  delivery_check: '15 minutos'
}))

app.get('/api/ml/accounts', async (req, res) => {
  const { empresa_id } = req.query
  if (!empresa_id) {
    return res.status(400).json({ error: 'empresa_id é obrigatório' })
  }
  const { data } = await sb.from('ml_accounts').select('id,nickname,active,created_at').eq('active', true).eq('empresa_id', empresa_id)
  res.json(data || [])
})

app.get('/api/orders', async (req, res) => {
  const { status, type, limit = 500 } = req.query
  let q = sb.from('ml_orders').select('*').order('created_at_ml', { ascending: false }).limit(Number(limit))
  if (status) q = q.eq('status', status)
  if (type) q = q.eq('order_type', type)
  const { data } = await q
  res.json(data || [])
})

app.patch('/api/orders/:id', async (req, res) => {
  const { data } = await sb.from('ml_orders').update({
    ...req.body,
    updated_at: new Date().toISOString()
  }).eq('id', req.params.id).select().single()
  res.json(data)
})

app.get('/api/sync', async (req, res) => {
  await syncAll()
  const { count } = await sb.from('ml_orders').select('*', { count: 'exact', head: true })
  res.json({ ok: true, total: count })
})

app.post('/api/sync', async (req, res) => {
  await syncAll()
  const { count } = await sb.from('ml_orders').select('*', { count: 'exact', head: true })
  res.json({ ok: true, total: count })
})

app.get('/api/stats', async (req, res) => {
  const { data } = await sb.from('ml_orders').select('status,order_type')
  res.json({
    aguardando: data?.filter(o => o.status === 'aguardando').length || 0,
    separando:  data?.filter(o => o.status === 'separando').length  || 0,
    embalado:   data?.filter(o => o.status === 'embalado').length   || 0,
    conferindo: data?.filter(o => o.status === 'conferindo').length || 0,
    finalizado: data?.filter(o => o.status === 'finalizado').length || 0,
    erro:       data?.filter(o => o.status === 'erro').length       || 0,
    full_ml:    data?.filter(o => o.order_type === 'FULL').length   || 0,
    flex:       data?.filter(o => o.order_type === 'FLEX').length   || 0,
    normal:     data?.filter(o => o.order_type === 'NORMAL').length || 0,
    total:      data?.length || 0
  })
})

let importStatus = { running: false, imported: 0, linked: 0, produtos_com_estoque_somado: 0, contaAtual: null, terminadoEm: null, erro: null }

async function rodarImportProducts(empresa_id) {
  importStatus = { running: true, imported: 0, linked: 0, produtos_com_estoque_somado: 0, contaAtual: null, terminadoEm: null, erro: null }
  try {
    const { data: accounts } = await sb.from('ml_accounts').select('*').eq('active', true).eq('empresa_id', empresa_id)

    for (const acc of accounts || []) {
      importStatus.contaAtual = acc.nickname
      try {
        const token = await getToken(acc)
        let scrollId = null
        let allIds = []

        // Busca TODOS os anúncios ativos da conta (não só os 100 primeiros)
        do {
          const url = scrollId
            ? `https://api.mercadolibre.com/users/${acc.ml_user_id}/items/search?search_type=scan&scroll_id=${scrollId}`
            : `https://api.mercadolibre.com/users/${acc.ml_user_id}/items/search?search_type=scan`
          const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } })
          allIds = allIds.concat(data.results || [])
          scrollId = data.scroll_id
          if (!data.results?.length) break
        } while (scrollId && allIds.length < 2000)

        // Busca detalhes em lotes de 20 (multiget)
        for (let i = 0; i < allIds.length; i += 20) {
          const batchIds = allIds.slice(i, i + 20)
          try {
            const { data: items } = await axios.get(
              `https://api.mercadolibre.com/items?ids=${batchIds.join(',')}`,
              { headers: { Authorization: `Bearer ${token}` } }
            )
            for (const entry of items || []) {
              if (entry.code !== 200) continue
              const item = entry.body
              const skuAttr = (item.attributes || []).find(a => a.id === 'SELLER_SKU')
              const skuReal = skuAttr?.value_name || item.seller_custom_field || null
              const sku = String(skuReal || item.id)

              await sb.from('products').upsert({
                sku,
                empresa_id: acc.empresa_id || null,
                name: item.title,
                photo: item.thumbnail ? item.thumbnail.replace('-I.jpg', '-O.jpg').replace('http://', 'https://') : null,
                active: true,
                source: 'mercadolivre',
                estoque_atual: item.available_quantity || 0
              }, { onConflict: 'empresa_id,sku', ignoreDuplicates: false })
              importStatus.imported++

              await sb.from('product_ml_links').upsert({
                empresa_id: acc.empresa_id || null,
                sku,
                account_nickname: acc.nickname,
                ml_item_id: String(item.id),
                ml_user_id: acc.ml_user_id,
                quantity: item.available_quantity || 0,
                updated_at: new Date().toISOString()
              }, { onConflict: 'account_nickname,ml_item_id' })
              importStatus.linked++
            }
          } catch (e) {
            console.log(`Erro lote import (${acc.nickname}): ${e.message}`)
          }
          await new Promise(r => setTimeout(r, 300))
        }
      } catch (e) {
        console.log(`Erro import-products (${acc.nickname}): ${e.message}`)
      }
    }

    // Depois de importar tudo, soma o estoque de todas as contas por SKU
    const { data: fresh } = await sb.from('product_ml_links').select('empresa_id,sku,quantity')
    const totals = {}
    for (const l of fresh || []) {
      const key = `${l.empresa_id}::${l.sku}`
      totals[key] = (totals[key] || 0) + (l.quantity || 0)
    }
    for (const [key, total] of Object.entries(totals)) {
      const [empresa_id, sku] = key.split('::')
      await sb.from('products')
        .update({ estoque_atual: total })
        .eq('empresa_id', empresa_id).eq('sku', sku)
    }
    importStatus.produtos_com_estoque_somado = Object.keys(totals).length
  } catch (e) {
    importStatus.erro = e.message
    console.log('Erro import-products:', e.message)
  } finally {
    importStatus.running = false
    importStatus.contaAtual = null
    importStatus.terminadoEm = new Date().toISOString()
  }
}

app.post('/api/ml/import-products', (req, res) => {
  const { empresa_id } = req.body
  if (!empresa_id) {
    return res.status(400).json({ ok: false, error: 'empresa_id é obrigatório — não é permitido importar sem saber de qual empresa é o pedido.' })
  }
  if (importStatus.running) {
    return res.json({ ok: true, message: 'Já está rodando, confere o progresso em /api/ml/import-products/status', status: importStatus })
  }
  rodarImportProducts(empresa_id) // não aguarda — roda em segundo plano
  res.json({ ok: true, message: 'Importação iniciada em segundo plano. Isso pode levar alguns minutos.' })
})

app.get('/api/ml/import-products/status', (req, res) => {
  res.json(importStatus)
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`🚀 TMP10 v9.5 porta ${PORT}`)
  // Diagnóstico seguro da Shopee — mostra só tamanho e se tinha espaço/quebra de linha sobrando, nunca o conteúdo
  const rawId = process.env.SHOPEE_PARTNER_ID || ''
  const rawKey = process.env.SHOPEE_PARTNER_KEY || ''
  console.log(`🔍 [Shopee] Partner ID: ${SHOPEE_PARTNER_ID ? SHOPEE_PARTNER_ID.length + ' caracteres' : 'NÃO CONFIGURADO'}${rawId !== SHOPEE_PARTNER_ID ? ' ⚠️ tinha espaço/quebra de linha sobrando (já removido automaticamente)' : ''}`)
  console.log(`🔍 [Shopee] Partner Key: ${SHOPEE_PARTNER_KEY ? SHOPEE_PARTNER_KEY.length + ' caracteres' : 'NÃO CONFIGURADO'}${rawKey !== SHOPEE_PARTNER_KEY ? ' ⚠️ tinha espaço/quebra de linha sobrando (já removido automaticamente)' : ''}`)
  setTimeout(syncAll, 3000)
  setTimeout(reclassifyOrders, 10000)
  setTimeout(checkDeliveries, 20000)
})
