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

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL / SUPABASE_SERVICE_KEY não configurados')
}

const sb = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  {
    realtime: {
      transport: ws
    }
  }
)

const ML_CLIENT_ID = process.env.ML_CLIENT_ID
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET

const RAILWAY_URL =
  process.env.RAILWAY_URL ||
  'https://tmp10-backend-v2-production.up.railway.app'

const ERP_URL =
  process.env.ERP_URL ||
  'https://roaring-pixie-c02520.netlify.app'

// ── Shopee Open Platform (OAuth v2) ─────────────────────────────────
//
// Sandbox da Shopee usa dois hosts:
//
// 1) SHOPEE_AUTH_HOST
//    Usado para abrir a tela de autorização.
//
// 2) SHOPEE_API_HOST
//    Usado para trocar o code por token e fazer chamadas da API.
//
// NÃO misturar os dois hosts.
//

const SHOPEE_PARTNER_ID_RAW =
  (process.env.SHOPEE_PARTNER_ID || '').trim()

const SHOPEE_PARTNER_ID =
  Number(SHOPEE_PARTNER_ID_RAW)

const SHOPEE_PARTNER_KEY =
  (process.env.SHOPEE_PARTNER_KEY || '').trim()

// Host da API Sandbox
const SHOPEE_API_HOST =
  (
    process.env.SHOPEE_API_HOST ||
    process.env.SHOPEE_HOST ||
    'https://partner.test-stable.shopeemobile.com'
  ).replace(/\/$/, '')

// Host de autorização Sandbox
const SHOPEE_AUTH_HOST =
  (
    process.env.SHOPEE_AUTH_HOST ||
    'https://openplatform.sandbox.test-stable.shopee.sg'
  ).replace(/\/$/, '')

const crypto = require('crypto')

function shopeeSign(
  path,
  timestamp,
  accessToken = '',
  shopId = ''
) {
  const baseString =
    `${SHOPEE_PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`

  return crypto
    .createHmac('sha256', SHOPEE_PARTNER_KEY)
    .update(baseString)
    .digest('hex')
}

// ── Notificações Push ────────────────────────────────────────────────

const VAPID_PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY || ''

const VAPID_PRIVATE_KEY =
  process.env.VAPID_PRIVATE_KEY || ''

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:contato@tmp10.com.br',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  )
}

// Salva a inscrição de notificação
app.post('/api/push/subscribe', async (req, res) => {
  try {
    const {
      empresa_id,
      user_id,
      subscription
    } = req.body

    if (
      !empresa_id ||
      !user_id ||
      !subscription?.endpoint
    ) {
      return res.status(400).json({
        error: 'Dados incompletos'
      })
    }

    const { error } =
      await sb
        .from('push_subscriptions')
        .upsert({
          empresa_id,
          user_id,
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth
        }, {
          onConflict: 'endpoint'
        })

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    res.json({
      ok: true
    })

  } catch (e) {
    res.status(500).json({
      error: e.message
    })
  }
})

// Remove inscrição
app.post('/api/push/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body

    if (!endpoint) {
      return res.status(400).json({
        error: 'endpoint obrigatório'
      })
    }

    await sb
      .from('push_subscriptions')
      .delete()
      .eq('endpoint', endpoint)

    res.json({
      ok: true
    })

  } catch (e) {
    res.status(500).json({
      error: e.message
    })
  }
})

// Envia notificação de nova venda
app.post('/api/push/notificar-venda', async (req, res) => {
  try {
    const {
      empresa_id,
      titulo,
      mensagem,
      excluir_user_id
    } = req.body

    if (!empresa_id) {
      return res.status(400).json({
        error: 'empresa_id obrigatório'
      })
    }

    let query =
      sb
        .from('push_subscriptions')
        .select('*')
        .eq('empresa_id', empresa_id)

    const {
      data: subs,
      error
    } = await query

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    const payload = JSON.stringify({
      title: titulo || '🔔 Nova venda!',
      body:
        mensagem ||
        'Um pedido novo foi registrado.',
      tag: 'nova-venda'
    })

    let enviados = 0

    for (const s of (subs || [])) {

      if (
        excluir_user_id &&
        s.user_id === excluir_user_id
      ) {
        continue
      }

      try {

        if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
          continue
        }

        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: {
              p256dh: s.p256dh,
              auth: s.auth
            }
          },
          payload
        )

        enviados++

      } catch (err) {

        if (
          err.statusCode === 404 ||
          err.statusCode === 410
        ) {
          await sb
            .from('push_subscriptions')
            .delete()
            .eq('endpoint', s.endpoint)
        }

      }
    }

    res.json({
      ok: true,
      enviados
    })

  } catch (e) {

    res.status(500).json({
      error: e.message
    })

  }
})

// Envia aviso para vendedores
app.post('/api/push/notificar-mensagem', async (req, res) => {
  try {

    const {
      empresa_id,
      titulo,
      mensagem,
      user_ids
    } = req.body

    if (!empresa_id || !mensagem) {
      return res.status(400).json({
        error:
          'empresa_id e mensagem são obrigatórios'
      })
    }

    let query =
      sb
        .from('push_subscriptions')
        .select('*')
        .eq('empresa_id', empresa_id)

    if (
      Array.isArray(user_ids) &&
      user_ids.length > 0
    ) {
      query = query.in(
        'user_id',
        user_ids
      )
    }

    const {
      data: subs,
      error
    } = await query

    if (error) {
      return res.status(500).json({
        error: error.message
      })
    }

    const payload = JSON.stringify({
      title: titulo || '📢 Aviso',
      body: mensagem,
      tag: 'aviso-equipe'
    })

    let enviados = 0

    for (const s of (subs || [])) {

      try {

        if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
          continue
        }

        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: {
              p256dh: s.p256dh,
              auth: s.auth
            }
          },
          payload
        )

        enviados++

      } catch (err) {

        if (
          err.statusCode === 404 ||
          err.statusCode === 410
        ) {
          await sb
            .from('push_subscriptions')
            .delete()
            .eq('endpoint', s.endpoint)
        }

      }
    }

    res.json({
      ok: true,
      enviados
    })

  } catch (e) {

    res.status(500).json({
      error: e.message
    })

  }
})

// ── Mercado Livre Auth ───────────────────────────────────────────────

app.get('/ml/auth/:accountId', (req, res) => {

  const empresaId =
    req.query.empresa_id || ''

  const redirectUri =
    `${RAILWAY_URL}/ml/callback`

  const state =
    `${req.params.accountId}:${empresaId}`

  const url =
    `https://auth.mercadolivre.com.br/authorization` +
    `?response_type=code` +
    `&client_id=${ML_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`

  res.redirect(url)
})

app.get('/ml/callback', async (req, res) => {

  const {
    code,
    state
  } = req.query

  const [
    accountId,
    empresaId
  ] =
    String(state || '').split(':')

  try {

    const {
      data: tok
    } =
      await axios.post(
        'https://api.mercadolibre.com/oauth/token',
        {
          grant_type:
            'authorization_code',

          client_id:
            ML_CLIENT_ID,

          client_secret:
            ML_CLIENT_SECRET,

          code,

          redirect_uri:
            `${RAILWAY_URL}/ml/callback`
        }
      )

    const {
      data: userInfo
    } =
      await axios.get(
        `https://api.mercadolibre.com/users/${tok.user_id}`,
        {
          headers: {
            Authorization:
              `Bearer ${tok.access_token}`
          }
        }
      )

    await sb
      .from('ml_accounts')
      .upsert({
        account_id: accountId,
        empresa_id:
          empresaId || null,

        ml_user_id:
          String(tok.user_id),

        nickname:
          userInfo.nickname,

        access_token:
          tok.access_token,

        refresh_token:
          tok.refresh_token,

        expires_at:
          new Date(
            Date.now() +
            tok.expires_in * 1000
          ).toISOString(),

        active: true

      }, {
        onConflict:
          'ml_user_id'
      })

    await syncMLOrders({
      ml_user_id:
        String(tok.user_id),

      access_token:
        tok.access_token,

      nickname:
        userInfo.nickname,

      empresa_id:
        empresaId || null
    })

    res.redirect(
      `${ERP_URL}?ml_connected=true&nickname=${userInfo.nickname}`
    )

  } catch (e) {

    console.error(
      'Auth error:',
      e.response?.data ||
      e.message
    )

    res.redirect(
      `${ERP_URL}?ml_error=true`
    )
  }
})

// ── Shopee OAuth v2 ─────────────────────────────────────────────────

// accountId é o id da linha em ml_accounts
// criada previamente para a loja Shopee.

app.get('/shopee/auth/:accountId', (req, res) => {

  if (
    !Number.isInteger(SHOPEE_PARTNER_ID) ||
    SHOPEE_PARTNER_ID < 0 ||
    SHOPEE_PARTNER_ID > 4294967295 ||
    !SHOPEE_PARTNER_KEY
  ) {

    return res.status(500).send(
      'SHOPEE_PARTNER_ID / SHOPEE_PARTNER_KEY inválidos ou não configurados no Railway'
    )
  }

  const empresaId =
    req.query.empresa_id || ''

  const path =
    '/api/v2/shop/auth_partner'

  const timestamp =
    Math.floor(Date.now() / 1000)

  const sign =
    shopeeSign(
      path,
      timestamp
    )

  const redirectBack =
    `${RAILWAY_URL}/shopee/callback` +
    `?account_id=${req.params.accountId}` +
    `&empresa_id=${empresaId}`

  const url =
    `${SHOPEE_AUTH_HOST}${path}` +
    `?partner_id=${SHOPEE_PARTNER_ID}` +
    `&timestamp=${timestamp}` +
    `&sign=${sign}` +
    `&redirect=${encodeURIComponent(redirectBack)}`

  console.log(
    '🔎 [Shopee DEBUG] /shopee/auth'
  )

  console.log(
    '🔎 [Shopee DEBUG] partner_id:',
    SHOPEE_PARTNER_ID
  )

  console.log(
    '🔎 [Shopee DEBUG] auth_host:',
    SHOPEE_AUTH_HOST
  )

  console.log(
    '🔎 [Shopee DEBUG] api_host:',
    SHOPEE_API_HOST
  )

  console.log(
    '🔎 [Shopee DEBUG] path:',
    path
  )

  console.log(
    '🔎 [Shopee DEBUG] timestamp:',
    timestamp
  )

  console.log(
    '🔎 [Shopee DEBUG] partner_key_length:',
    SHOPEE_PARTNER_KEY.length
  )

  console.log(
    '🔎 [Shopee DEBUG] redirect:',
    redirectBack
  )

  res.redirect(url)
})

app.get('/shopee/callback', async (req, res) => {

  const {
    code,
    shop_id,
    account_id,
    empresa_id
  } = req.query

  try {

    if (!code || !shop_id) {
      throw new Error(
        'Shopee não devolveu code/shop_id — autorização cancelada ou incompleta'
      )
    }

    const path =
      '/api/v2/auth/token/get'

    const timestamp =
      Math.floor(Date.now() / 1000)

    const sign =
      shopeeSign(
        path,
        timestamp
      )

    const {
      data: tok
    } =
      await axios.post(

        `${SHOPEE_API_HOST}${path}` +
        `?partner_id=${SHOPEE_PARTNER_ID}` +
        `&timestamp=${timestamp}` +
        `&sign=${sign}`,

        {
          code,

          shop_id:
            Number(shop_id),

          partner_id:
            Number(SHOPEE_PARTNER_ID)
        }
      )

    if (tok.error) {
      throw new Error(
        `${tok.error}: ${tok.message}`
      )
    }

    const updatePayload = {

      platform:
        'shopee',

      ml_user_id:
        String(shop_id),

      access_token:
        tok.access_token,

      refresh_token:
        tok.refresh_token,

      expires_at:
        new Date(
          Date.now() +
          tok.expire_in * 1000
        ).toISOString(),

      active:
        true
    }

    if (account_id) {

      await sb
        .from('ml_accounts')
        .update(updatePayload)
        .eq('id', account_id)

    } else {

      await sb
        .from('ml_accounts')
        .insert({
          ...updatePayload,

          empresa_id:
            empresa_id || null,

          nickname:
            `Shopee ${shop_id}`
        })

    }

    res.redirect(
      `${ERP_URL}?shopee_connected=true&shop_id=${shop_id}`
    )

  } catch (e) {

    console.error(
      'Shopee auth error:',
      e.response?.data ||
      e.message
    )

    res.redirect(
      `${ERP_URL}?shopee_error=${encodeURIComponent(e.message)}`
    )
  }
})

async function refreshShopeeToken(account) {

  try {

    const path =
      '/api/v2/auth/access_token/get'

    const timestamp =
      Math.floor(Date.now() / 1000)

    const sign =
      shopeeSign(
        path,
        timestamp
      )

    const {
      data
    } =
      await axios.post(

        `${SHOPEE_API_HOST}${path}` +
        `?partner_id=${SHOPEE_PARTNER_ID}` +
        `&timestamp=${timestamp}` +
        `&sign=${sign}`,

        {
          refresh_token:
            account.refresh_token,

          shop_id:
            Number(account.ml_user_id),

          partner_id:
            Number(SHOPEE_PARTNER_ID)
        }
      )

    if (data.error) {
      throw new Error(
        `${data.error}: ${data.message}`
      )
    }

    await sb
      .from('ml_accounts')
      .update({

        access_token:
          data.access_token,

        refresh_token:
          data.refresh_token,

        expires_at:
          new Date(
            Date.now() +
            data.expire_in * 1000
          ).toISOString()

      })
      .eq(
        'ml_user_id',
        account.ml_user_id
      )
      .eq(
        'platform',
        'shopee'
      )

    console.log(
      `🔑 [Shopee] Token renovado: loja ${account.ml_user_id}`
    )

    return data.access_token

  } catch (e) {

    console.error(
      `❌ [Shopee] FALHA ao renovar token da loja ${account.ml_user_id}:`,
      e.response?.data ||
      e.message
    )

    return account.access_token
  }
}

async function getShopeeToken(account) {

  if (!account.expires_at) {
    return account.access_token
  }

  if (
    new Date(account.expires_at) <
    new Date(
      Date.now() +
      5 * 60 * 1000
    )
  ) {

    return await refreshShopeeToken(
      account
    )
  }

  return account.access_token
}

// Renova tokens Shopee automaticamente
cron.schedule(
  '*/10 * * * *',
  async () => {

    const {
      data: contas
    } =
      await sb
        .from('ml_accounts')
        .select('*')
        .eq('platform', 'shopee')
        .eq('active', true)

    for (
      const acc of (contas || [])
    ) {

      if (
        acc.access_token &&
        acc.refresh_token
      ) {

        await getShopeeToken(
          acc
        )
      }
    }
  }
)

// ── Token Mercado Livre ─────────────────────────────────────────────

async function refreshToken(account) {

  try {

    const {
      data
    } =
      await axios.post(
        'https://api.mercadolibre.com/oauth/token',
        {
          grant_type:
            'refresh_token',

          client_id:
            ML_CLIENT_ID,

          client_secret:
            ML_CLIENT_SECRET,

          refresh_token:
            account.refresh_token
        }
      )

    await sb
      .from('ml_accounts')
      .update({

        access_token:
          data.access_token,

        refresh_token:
          data.refresh_token,

        expires_at:
          new Date(
            Date.now() +
            data.expires_in * 1000
          ).toISOString()

      })
      .eq(
        'ml_user_id',
        account.ml_user_id
      )

    console.log(
      `🔑 Token renovado com sucesso: ${account.nickname}`
    )

    return data.access_token

  } catch (e) {

    console.error(
      `❌ FALHA ao renovar token de ${account.nickname}:`,
      e.response?.data
        ? JSON.stringify(
            e.response.data
          )
        : e.message
    )

    return account.access_token
  }
}

async function getToken(account) {

  if (!account.expires_at) {
    return account.access_token
  }

  if (
    new Date(account.expires_at) <
    new Date(
      Date.now() +
      5 * 60 * 1000
    )
  ) {

    return await refreshToken(
      account
    )
  }

  return account.access_token
}

// ── Detectar FULL / FLEX / NORMAL ───────────────────────────────────

function isFulfillment(shipment) {

  const logistic =
    (
      shipment?.logistic_type ||
      ''
    ).toLowerCase()

  const tags =
    shipment?.tags || []

  if (
    logistic === 'fulfillment'
  ) {
    return true
  }

  if (
    tags.includes(
      'meli_fulfillment'
    )
  ) {
    return true
  }

  return false
}

async function detectOrderType(
  order,
  token
) {

  const tags =
    order.tags || []

  const shippingLogistic =
    (
      order.shipping?.logistic_type ||
      ''
    ).toLowerCase()

  if (
    tags.includes(
      'meli_fulfillment'
    )
  ) {
    return 'FULL'
  }

  if (
    shippingLogistic ===
    'fulfillment'
  ) {
    return 'FULL'
  }

  if (
    shippingLogistic ===
    'self_service'
  ) {
    return 'FLEX'
  }

  if (
    shippingLogistic ===
    'drop_off'
  ) {
    return 'NORMAL'
  }

  const shipmentId =
    order.shipping?.id

  if (
    shipmentId &&
    token
  ) {

    try {

      const {
        data: shipment
      } =
        await axios.get(
          `https://api.mercadolibre.com/shipments/${shipmentId}`,
          {
            headers: {
              Authorization:
                `Bearer ${token}`
            },
            timeout: 5000
          }
        )

      const logistic =
        (
          shipment.logistic_type ||
          ''
        ).toLowerCase()

      console.log(
        `Shipment ${shipmentId}: logistic=${logistic} tags=${(shipment.tags || []).join(',')}`
      )

      if (
        isFulfillment(
          shipment
        )
      ) {
        return 'FULL'
      }

      if (
        logistic ===
        'self_service'
      ) {
        return 'FLEX'
      }

      return 'NORMAL'

    } catch (e) {

      console.log(
        `Shipment ${shipmentId} lookup failed: ${e.message}`
      )
    }
  }

  return 'NORMAL'
}

// ── Custos reais ML ─────────────────────────────────────────────────

async function calcCustosReaisML(
  mlOrderId,
  token
) {

  if (
    !mlOrderId ||
    !token
  ) {

    return {
      saleFeeLiquido: 0,
      freteVendedor: 0,
      bonusCampanha: 0
    }
  }

  try {

    const {
      data
    } =
      await axios.get(
        `https://api.mercadolibre.com/orders/${mlOrderId}/billing_info`,
        {
          headers: {
            Authorization:
              `Bearer ${token}`
          },
          timeout: 8000
        }
      )

    let saleFeeLiquido = 0
    let freteVendedor = 0
    let bonusCampanha = 0

    const items =
      data?.items || []

    for (
      const item of items
    ) {

      const tipo =
        (
          item.type ||
          ''
        ).toLowerCase()

      const subtipo =
        (
          item.subtype ||
          ''
        ).toLowerCase()

      const valor =
        Math.abs(
          item.amount || 0
        )

      if (
        tipo === 'market_fee' ||
        subtipo === 'sale_fee'
      ) {

        saleFeeLiquido +=
          valor

      } else if (
        tipo === 'shipping' ||
        subtipo === 'shipping'
      ) {

        if (
          (item.amount || 0) < 0
        ) {

          freteVendedor +=
            valor
        }

      } else if (
        tipo === 'discount' ||
        subtipo === 'campaign'
      ) {

        bonusCampanha +=
          valor
      }
    }

    console.log(
      `billing_info ${mlOrderId}: fee=${saleFeeLiquido} frete=${freteVendedor} bonus=${bonusCampanha}`
    )

    return {
      saleFeeLiquido,
      freteVendedor,
      bonusCampanha
    }

  } catch (e) {

    console.log(
      `billing_info falhou ${mlOrderId}: ${e.message}`
    )

    return null
  }
}

async function calcCustosFallback(
  order,
  token
) {

  const totalAmount =
    order.total_amount || 0

  const paidAmountML =
    order.payments?.[0]
      ?.total_paid_amount ||
    order.paid_amount ||
    0

  const custoTotal =
    totalAmount -
    paidAmountML

  const saleFeeTot =
    order.order_items?.reduce(
      (s, i) =>
        s + (i.sale_fee || 0),
      0
    ) || 0

  const freteVendedor =
    Math.max(
      0,
      custoTotal -
      saleFeeTot
    )

  return {
    saleFeeLiquido:
      saleFeeTot,

    freteVendedor,

    bonusCampanha:
      0
  }
}
