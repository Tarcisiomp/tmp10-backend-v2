require('dotenv').config()
const express = require('express')
const cors = require('cors')
const axios = require('axios')
const cron = require('node-cron')
const { createClient } = require('@supabase/supabase-js')
const webpush = require('web-push')

const app = express()
app.use(cors())
app.use(express.json())

const sb = createClient(
  process.env.SUPABASE_URL || 'https://foshqdjgbcigggrcjtap.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvc2hxZGpnYmNpZ2dncmNqdGFwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTQwMDAyMSwiZXhwIjoyMDk0OTc2MDIxfQ.6h_Pouyxs73jug7JJtCtfj50JJPi1whWnAkdJuPNSoI'
)

const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '4022957335913783'
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'f9jB9yc6UvrAnz4kjT6u02xMxjbvn7z3'
const RAILWAY_URL      = 'https://web-production-82c10.up.railway.app'
const ERP_URL          = process.env.ERP_URL || 'https://roaring-pixie-c02520.netlify.app'

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
          const { data } = await axios.get(
            `https://api.mercadolibre.com/orders/search?seller=${account.ml_user_id}&order.status=${mlStatus}&order.date_created.from=${encodeURIComponent(dateFromStr)}&sort=date_desc&limit=50&offset=${offset}`,
            { headers: { Authorization: `Bearer ${token}` } }
          )

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

              await sb.from('ml_orders').insert({
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
  for (const acc of accounts) await syncMLOrders(acc)
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
          `https://api.mercadolibre.com/my/questions/search?status=UNANSWERED&limit=20`,
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
    for (const [key, total] of Object.entries(totals)) {
      const [empresa_id, sku] = key.split('::')
      await sb.from('products')
        .update({ estoque_atual: total, updated_at: new Date().toISOString() })
        .eq('empresa_id', empresa_id).eq('sku', sku)
    }

    console.log(`✅ Sync estoque ML concluído (${links.length} anúncios, ${Object.keys(totals).length} produtos atualizados)`)
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
  setTimeout(syncAll, 3000)
  setTimeout(reclassifyOrders, 10000)
  setTimeout(checkDeliveries, 20000)
})
