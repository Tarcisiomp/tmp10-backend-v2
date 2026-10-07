// Estoque Central — chamadas às plataformas (Mercado Livre e Shopee).
//
// Só usa endpoints e campos que o TMP10 JÁ usa hoje (server.js), sem inventar contrato:
//   Mercado Livre: GET /items?ids=<até 20>  (campo available_quantity — usado em syncEstoqueML e na importação)
//                  PUT /items/{id} com { available_quantity }  (era o envio de pushEstoqueParaML)
//   Shopee:        GET /api/v2/product/get_item_base_info   (stock_info_v2.summary_info.total_available_stock — usado na importação)
//                  GET /api/v2/product/get_model_list       (model[].stock_info_v2.summary_info.total_available_stock — idem)
//                  POST /api/v2/product/update_stock        (mesmo corpo de pushEstoqueParaShopee)
//
// PRECISA CONFIRMAR (marcado no código onde é usado):
//   • ML: campo "variations" do anúncio — usado SÓ para BLOQUEAR o envio em anúncio com variação (nunca para enviar).
//   • Shopee: "response.failure_list" do update_stock — se vier preenchido, o envio é tratado como erro.
//   • Shopee: total_available_stock é o número certo para comparar com o estoque enviado (seller_stock)?

const ML_API = 'https://api.mercadolibre.com'

class ErroPlataforma extends Error {
  // tipo: 'temporario' (tenta de novo depois) | 'permanente' (precisa de atenção) | 'token' (renovar e tentar 1 vez)
  constructor(mensagem, { tipo = 'permanente', http = null, resposta = null } = {}) {
    super(mensagem); this.tipo = tipo; this.http = http; this.resposta = resposta
  }
}

const resumir = (x) => { try { return (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 1000) } catch { return String(x).slice(0, 1000) } }

// Erro do axios → tipo. Sem resposta (rede/tempo) ou 429/5xx = temporário; 401 = token; resto = permanente.
function classificarErroHttp(e, contexto) {
  const st = e && e.response ? e.response.status : null
  const corpo = e && e.response ? e.response.data : null
  const msg = `${contexto}: ${st ? 'HTTP ' + st : (e && e.code) || 'sem resposta'}${corpo ? ' ' + resumir(corpo) : (e && e.message ? ' ' + e.message : '')}`
  if (!st) return new ErroPlataforma(msg, { tipo: 'temporario', http: null, resposta: resumir(e && e.message) })
  if (st === 401) return new ErroPlataforma(msg, { tipo: 'token', http: st, resposta: resumir(corpo) })
  if (st === 429 || st >= 500) return new ErroPlataforma(msg, { tipo: 'temporario', http: st, resposta: resumir(corpo) })
  return new ErroPlataforma(msg, { tipo: 'permanente', http: st, resposta: resumir(corpo) })
}

function criarMercadoLivre({ axios, getToken, refreshToken, timeout = 8000 }) {
  // Executa com o token da conta; se o ML responder 401, renova o token UMA vez e tenta de novo.
  async function comToken(conta, fn, contexto) {
    let token = await getToken(conta)
    if (!token) throw new ErroPlataforma(`${contexto}: conta ${conta.nickname} sem token`, { tipo: 'permanente' })
    try {
      return await fn(token)
    } catch (e) {
      const erro = e instanceof ErroPlataforma ? e : classificarErroHttp(e, contexto)
      if (erro.tipo !== 'token') throw erro
      token = await refreshToken(conta)
      if (token) conta.access_token = token // as próximas chamadas deste envio já usam o token novo
      try { return await fn(token) } catch (e2) {
        const erro2 = e2 instanceof ErroPlataforma ? e2 : classificarErroHttp(e2, contexto)
        if (erro2.tipo === 'token') erro2.tipo = 'temporario'
        throw erro2
      }
    }
  }

  // Lê até 20 anúncios: Map(id → { quantidade, variacoes, codigo })
  async function lerAnuncios(conta, ids) {
    if (!ids.length) return new Map()
    if (ids.length > 20) throw new Error('lerAnuncios: no máximo 20 por vez')
    return comToken(conta, async (token) => {
      const { data } = await axios.get(`${ML_API}/items?ids=${ids.map(encodeURIComponent).join(',')}`, { headers: { Authorization: `Bearer ${token}` }, timeout })
      const mapa = new Map(); const recusas = []
      for (const entrada of (Array.isArray(data) ? data : [])) {
        const corpo = entrada && entrada.body
        const id = corpo && corpo.id ? String(corpo.id) : null
        if (!entrada || entrada.code !== 200 || !id) { recusas.push(`${entrada && entrada.code}: ${resumir(corpo)}`); continue }
        mapa.set(id, {
          quantidade: Number.isFinite(Number(corpo.available_quantity)) && corpo.available_quantity !== null ? Number(corpo.available_quantity) : null,
          // PRECISA CONFIRMAR: "variations" — só usado para BLOQUEAR envio em anúncio com variação
          variacoes: Array.isArray(corpo.variations) ? corpo.variations.length : 0,
          codigo: 200
        })
      }
      // anúncio que o ML não devolveu para esta conta (de outra conta, apagado, sem permissão)
      for (const id of ids) if (!mapa.has(String(id))) mapa.set(String(id), { erro: `ML não devolveu o anúncio ${id} para a conta ${conta.nickname}${recusas.length ? ' (' + recusas.join(' | ').slice(0, 400) + ')' : ''}` })
      return mapa
    }, `ML GET /items (${conta.nickname})`)
  }

  // Envia o número absoluto para um anúncio SEM variação (contrato já usado pelo TMP10)
  async function enviar(conta, itemId, quantidade) {
    return comToken(conta, async (token) => {
      const r = await axios.put(`${ML_API}/items/${encodeURIComponent(itemId)}`, { available_quantity: quantidade },
        { headers: { Authorization: `Bearer ${token}` }, timeout })
      return { http: r && r.status ? r.status : 200 }
    }, `ML PUT /items/${itemId} (${conta.nickname})`)
  }

  return { lerAnuncios, enviar }
}

function criarShopee({ axios, host, partnerId, assinar, getToken, refreshToken, timeout = 10000 }) {
  const ehSandbox = () => /test-stable/i.test(String(host || ''))
  const shopIdDe = (conta) => Number(conta.ml_user_id)

  async function chamar(conta, metodo, path, { params = {}, corpo = null } = {}, contexto) {
    const tentar = async (token) => {
      const shopId = shopIdDe(conta)
      const timestamp = Math.floor(Date.now() / 1000)
      const sign = assinar(path, timestamp, token, shopId)
      const base = { partner_id: Number(partnerId), timestamp, sign, shop_id: shopId, access_token: token }
      let r
      try {
        r = metodo === 'get'
          ? await axios.get(`${host}${path}`, { params: { ...base, ...params }, timeout })
          : await axios.post(`${host}${path}`, { partner_id: Number(partnerId), shop_id: shopId, timestamp, access_token: token, ...corpo }, { params: base, timeout })
      } catch (e) { throw classificarErroHttp(e, contexto) }
      const data = r && r.data
      if (data && data.error) {
        // a Shopee responde HTTP 200 com "error" preenchido (mesma checagem que o TMP10 já faz nos pedidos)
        const texto = `${contexto}: ${data.error}${data.message ? ' — ' + data.message : ''}`
        const ehToken = /token|auth/i.test(String(data.error)) // PRECISA CONFIRMAR os códigos exatos de token vencido
        throw new ErroPlataforma(texto, { tipo: ehToken ? 'token' : 'permanente', http: r.status || 200, resposta: resumir(data) })
      }
      return data
    }
    let token = await getToken(conta)
    if (!token) throw new ErroPlataforma(`${contexto}: loja ${conta.nickname} sem token`, { tipo: 'permanente' })
    try { return await tentar(token) } catch (e) {
      if (!(e instanceof ErroPlataforma) || e.tipo !== 'token') throw e
      token = await refreshToken(conta)
      if (token) conta.access_token = token
      try { return await tentar(token) } catch (e2) { if (e2.tipo === 'token') e2.tipo = 'temporario'; throw e2 }
    }
  }

  const estoqueDe = (x) => {
    const v = x && x.stock_info_v2 && x.stock_info_v2.summary_info ? x.stock_info_v2.summary_info.total_available_stock : null
    return Number.isFinite(Number(v)) && v !== null ? Number(v) : null
  }

  // Itens sem variação, até 20: Map(item_id → { quantidade })
  async function lerItens(conta, itemIds) {
    if (!itemIds.length) return new Map()
    if (itemIds.length > 20) throw new Error('lerItens: no máximo 20 por vez')
    const data = await chamar(conta, 'get', '/api/v2/product/get_item_base_info', { params: { item_id_list: itemIds.join(',') } }, `Shopee get_item_base_info (${conta.nickname})`)
    const mapa = new Map()
    for (const item of ((data && data.response && data.response.item_list) || [])) mapa.set(String(item.item_id), { quantidade: estoqueDe(item) })
    return mapa
  }

  // Variações de um item: Map(model_id → { quantidade })
  async function lerModelos(conta, itemId) {
    const data = await chamar(conta, 'get', '/api/v2/product/get_model_list', { params: { item_id: Number(itemId) } }, `Shopee get_model_list ${itemId} (${conta.nickname})`)
    const mapa = new Map()
    for (const m of ((data && data.response && data.response.model) || [])) mapa.set(String(m.model_id), { quantidade: estoqueDe(m) })
    return mapa
  }

  // Envia o número absoluto: com model_id (variação) ou sem (produto simples) — mesmo corpo já usado pelo TMP10
  async function enviar(conta, itemId, modelId, quantidade) {
    const stock_list = modelId
      ? [{ model_id: Number(modelId), seller_stock: [{ stock: quantidade }] }]
      : [{ seller_stock: [{ stock: quantidade }] }]
    const data = await chamar(conta, 'post', '/api/v2/product/update_stock', { corpo: { item_id: Number(itemId), stock_list } }, `Shopee update_stock ${itemId}${modelId ? '/' + modelId : ''} (${conta.nickname})`)
    // PRECISA CONFIRMAR: "failure_list" — se a Shopee devolver falhas por variação, o envio NÃO é dado como certo
    const falhas = data && data.response && Array.isArray(data.response.failure_list) ? data.response.failure_list : []
    if (falhas.length) throw new ErroPlataforma(`Shopee update_stock ${itemId}: falha ${resumir(falhas)}`, { tipo: 'permanente', http: 200, resposta: resumir(data) })
    return { http: 200, resposta: resumir(data) }
  }

  return { lerItens, lerModelos, enviar, ehSandbox }
}

module.exports = { criarMercadoLivre, criarShopee, ErroPlataforma, classificarErroHttp, resumir }
