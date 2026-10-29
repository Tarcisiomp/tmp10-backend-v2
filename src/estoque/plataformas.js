// Estoque Central — chamadas às plataformas (Mercado Livre e Shopee).
//
// Só usa endpoints e campos que o TMP10 JÁ usa hoje (server.js), sem inventar contrato:
//   Mercado Livre: GET /items?ids=<até 20>  (campo available_quantity — usado em syncEstoqueML e na importação)
//                  PUT /items/{id} com { available_quantity }  (era o envio de pushEstoqueParaML)
//   Shopee:        GET /api/v2/product/get_item_base_info   (stock_info_v2.summary_info.total_available_stock — usado na importação)
//                  GET /api/v2/product/get_model_list       (model[].stock_info_v2.summary_info.total_available_stock — idem)
//                  POST /api/v2/product/update_stock        (mesmo corpo de pushEstoqueParaShopee)
//                  GET /api/v2/product/get_item_promotion   (só no DIAGNÓSTICO; item_id_list) — novo, ver abaixo
//
// Documentação da Shopee (texto da doc oficial reproduzido no SDK @congminh1254/shopee-sdk 2.9.0, gerado a partir dela):
//   • update_stock: "Whenever there is a promotion ongoing or upcoming, the total stock must be larger than or equal to
//     real-time reserved_stock promotion stock (Please check v2.get_item_promotion API for more details)".
//   • get_model_list / get_item_base_info: stock_info_v2.summary_info.total_reserved_stock = "Stock reserved for promotion";
//     summary_info.total_available_stock = "Stock can be sold currently"; seller_stock[] = {location_id, stock, if_saleable}.
//   • get_item_promotion: success_list[].promotion[] = {promotion_type, promotion_id, model_id, start_time, end_time,
//     promotion_staging (ongoing/upcoming), promotion_stock_info_v2 (reserva da promoção)}; failure_list[] = {item_id, failed_reason}.
//
// PRECISA CONFIRMAR (marcado no código onde é usado):
//   • ML: campo "variations" do anúncio — usado SÓ para BLOQUEAR o envio em anúncio com variação (nunca para enviar).
//   • Shopee: "response.failure_list" do update_stock — se vier preenchido, o envio é tratado como erro.
//   • Shopee: total_available_stock é o número certo para comparar com o estoque enviado (seller_stock)?

const ML_API = 'https://api.mercadolibre.com'

class ErroPlataforma extends Error {
  // tipo: 'temporario' (tenta de novo depois) | 'permanente' (precisa de atenção) | 'token' (renovar e tentar 1 vez)
  //       | 'reserva' (Shopee: estoque reservado maior que o número enviado — não adianta repetir)
  // categoria (para diagnóstico; não muda a regra de nova tentativa): 'comunicacao' (rede/tempo/429/5xx) | 'autenticacao'
  //   (token/permissão) | 'negocio' (a plataforma respondeu e recusou) | 'reserva_promocao' (Shopee: estoque reservado para promoção)
  // dados: o corpo da resposta da plataforma (objeto), quando houver — sem credenciais (a Shopee não devolve token no corpo)
  constructor(mensagem, { tipo = 'permanente', http = null, resposta = null, requisicao = null, reserva = null, categoria = null, dados = null } = {}) {
    super(mensagem); this.tipo = tipo; this.http = http; this.resposta = resposta; this.requisicao = requisicao; this.reserva = reserva; this.dados = dados
    this.categoria = categoria || ({ temporario: 'comunicacao', token: 'autenticacao', reserva: 'reserva_promocao' })[tipo] || 'negocio'
  }
}

// Recusa da Shopee por ESTOQUE RESERVADO. Texto exato devolvido em produção (08/10 e 09/10/2026):
//   "Stock should be larger than 13 (reserve stock number) for model 01 UN BRANCO"
// Só reconhece esse formato; qualquer outro texto continua como recusa comum ('permanente').
const reservaDoTexto = (texto) => {
  const m = /larger than\s+(\d+)\s*\(reserve stock number\)/i.exec(String(texto || ''))
  return m ? Number(m[1]) : null
}

const resumir = (x, max = 1000) => { try { return (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, max) } catch { return String(x).slice(0, max) } }
// Motivos que a Shopee devolve em response.failure_list (um por variação). Mostra os campos que vierem, sem supor nomes.
const motivosFalha = (lista) => (Array.isArray(lista) ? lista : []).map((f) => {
  if (!f || typeof f !== 'object') return String(f)
  const motivo = f.failed_reason || f.fail_reason || f.reason || f.message
  return `${f.model_id !== undefined ? 'variação ' + f.model_id + ': ' : ''}${motivo || JSON.stringify(f)}`
}).join(' | ')

// Erro do axios → tipo. Sem resposta (rede/tempo) ou 429/5xx = temporário; 401 = token; resto = permanente.
// categoria: sem resposta/429/5xx = comunicação; 401/403 = autenticação; outro HTTP de erro = negócio.
function classificarErroHttp(e, contexto) {
  const st = e && e.response ? e.response.status : null
  const corpo = e && e.response ? e.response.data : null
  const msg = `${contexto}: ${st ? 'HTTP ' + st : (e && e.code) || 'sem resposta'}${corpo ? ' ' + resumir(corpo) : (e && e.message ? ' ' + e.message : '')}`
  const dados = corpo && typeof corpo === 'object' ? corpo : null
  if (!st) return new ErroPlataforma(msg, { tipo: 'temporario', http: null, resposta: resumir(e && e.message), categoria: 'comunicacao' })
  if (st === 401) return new ErroPlataforma(msg, { tipo: 'token', http: st, resposta: resumir(corpo), categoria: 'autenticacao', dados })
  if (st === 429 || st >= 500) return new ErroPlataforma(msg, { tipo: 'temporario', http: st, resposta: resumir(corpo), categoria: 'comunicacao', dados })
  return new ErroPlataforma(msg, { tipo: 'permanente', http: st, resposta: resumir(corpo), categoria: st === 403 ? 'autenticacao' : 'negocio', dados })
}

// SKU que o anúncio do ML declara — mesma regra da importação de produtos (server.js): SELLER_SKU → seller_custom_field
const skuDeclaradoML = (corpo) => {
  const attr = Array.isArray(corpo && corpo.attributes) ? corpo.attributes.find((a) => a && a.id === 'SELLER_SKU') : null
  const v = (attr && attr.value_name) || (corpo && corpo.seller_custom_field) || null
  return v ? String(v).trim() : null
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
          codigo: 200,
          // título e SKU declarado no anúncio: MESMOS campos que a importação de produtos do server.js já usa
          // (title; atributo SELLER_SKU → seller_custom_field). Só leitura/diagnóstico.
          titulo: corpo.title ?? null,
          sku_declarado: skuDeclaradoML(corpo),
          // imagem do anúncio (campos do recurso /items: secure_thumbnail / thumbnail) — só para exibir na tela de agrupamento
          imagem: corpo.secure_thumbnail || corpo.thumbnail || null,
          // inventory_id: identificador do estoque Full do anúncio (doc oficial ML "Envios Fulfillment": GET /items/{id} → inventory_id;
          // anúncio com variações tem um inventory_id por variação). Só LEITURA: usado para separar o Full e para NUNCA enviar a ele.
          inventory_id: corpo.inventory_id ? String(corpo.inventory_id) : null
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

  // Pedidos do vendedor por status, desde uma data (SÓ LEITURA). Mesma URL e parâmetros do syncMLOrders (server.js):
  //   /orders/search?seller=…&order.status=…&order.date_created.from=…&sort=date_desc&limit=50&offset=…
  // Devolve [{ id, status, criado, itens: [{ anuncio, sku, qtd }] }]. Acima de maxPaginas, recusa (não dá para conferir tudo).
  async function buscarPedidos(conta, status, desde, { maxPaginas = 200 } = {}) {
    const dataStr = new Date(desde).toISOString().slice(0, 19) + '.000-00:00'
    return comToken(conta, async (token) => {
      const pedidos = []
      for (let pagina = 0, offset = 0; ; pagina++, offset += 50) {
        if (pagina >= maxPaginas) throw new ErroPlataforma(`ML pedidos ${status} (${conta.nickname}): mais de ${maxPaginas * 50} pedidos em 30 dias — não foi possível conferir todos`, { tipo: 'permanente', categoria: 'negocio' })
        const { data } = await axios.get(`${ML_API}/orders/search?seller=${encodeURIComponent(conta.ml_user_id)}&order.status=${encodeURIComponent(status)}&order.date_created.from=${encodeURIComponent(dataStr)}&sort=date_desc&limit=50&offset=${offset}`,
          { headers: { Authorization: `Bearer ${token}` }, timeout })
        const resultados = (data && Array.isArray(data.results)) ? data.results : []
        const total = data && data.paging && Number.isFinite(Number(data.paging.total)) ? Number(data.paging.total) : 0
        for (const o of resultados) {
          pedidos.push({ id: String(o.id), status: o.status || status, criado: o.date_created || null,
            itens: (o.order_items || []).map((it) => ({ anuncio: it && it.item && it.item.id ? String(it.item.id) : null,
              sku: it && it.item && it.item.seller_sku ? String(it.item.seller_sku).trim() : null, qtd: Number(it && it.quantity) || 1 })) })
        }
        if (!resultados.length || offset + 50 >= total) break
      }
      return pedidos
    }, `ML GET /orders/search ${status} (${conta.nickname})`)
  }

  // Um pedido (SÓ LEITURA) — mesmo endpoint do webhook orders_v2 do server.js: GET /orders/{id}
  async function lerPedido(conta, id) {
    return comToken(conta, async (token) => {
      const { data } = await axios.get(`${ML_API}/orders/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, timeout })
      return { id: String(id), status: data && data.status ? String(data.status) : null }
    }, `ML GET /orders/${id} (${conta.nickname})`)
  }

  // Saldo FULL de um anúncio (SÓ LEITURA). Doc oficial ML "Envios Fulfillment" (developers.mercadolibre — fulfillment):
  //   GET /inventories/{inventory_id}/stock/fulfillment → { inventory_id, total, available_quantity, not_available_quantity,
  //   not_available_detail: [{ status, quantity }], external_references: [{ type: 'item', id, variation_id }] }
  //   Erros documentados: 400, 401, 403, 404 (seller_product_not_found), 429, 500.
  // Número ausente/ inválido na resposta → ERRO (nunca vira zero). Não existe envio de estoque Full por API (a doc só permite consultar).
  async function lerEstoqueFull(conta, inventoryId) {
    if (!inventoryId) throw new ErroPlataforma('lerEstoqueFull: inventory_id vazio', { tipo: 'permanente' })
    return comToken(conta, async (token) => {
      const { data } = await axios.get(`${ML_API}/inventories/${encodeURIComponent(inventoryId)}/stock/fulfillment`, { headers: { Authorization: `Bearer ${token}` }, timeout })
      const n = (v) => (v === null || v === undefined || v === '' || !Number.isInteger(Number(v)) || Number(v) < 0 ? null : Number(v))
      const r = { inventory_id: data && data.inventory_id ? String(data.inventory_id) : String(inventoryId),
        disponivel: n(data && data.available_quantity), nao_disponivel: n(data && data.not_available_quantity), total: n(data && data.total),
        detalhe: data && Array.isArray(data.not_available_detail) ? data.not_available_detail : null,
        referencias: data && Array.isArray(data.external_references) ? data.external_references : null }
      if (r.disponivel === null || r.total === null) throw new ErroPlataforma(`ML /inventories/${inventoryId}/stock/fulfillment sem available_quantity/total válidos: ${resumir(data, 300)}`, { tipo: 'permanente', categoria: 'negocio', dados: data })
      return r
    }, `ML GET /inventories/${inventoryId}/stock/fulfillment (${conta.nickname})`)
  }

  return { lerAnuncios, enviar, buscarPedidos, lerPedido, lerEstoqueFull }
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
        // a Shopee responde HTTP 200 com "error" preenchido (mesma checagem que o TMP10 já faz nos pedidos).
        // Quando o erro diz "check failure_list", o motivo real vem em response.failure_list: ele entra na mensagem.
        const motivos = motivosFalha(data.response && data.response.failure_list)
        const texto = `${contexto}: ${data.error}${data.message ? ' — ' + data.message : ''}${motivos ? ' · motivo da Shopee: ' + motivos : ''}`
        const ehToken = /token|auth/i.test(String(data.error)) // PRECISA CONFIRMAR os códigos exatos de token vencido
        const reserva = reservaDoTexto(motivos) ?? reservaDoTexto(data.message)
        // requisição SEM credenciais (sem access_token, sign, partner_id) — para o diagnóstico
        const requisicao = { metodo: metodo.toUpperCase(), path, shop_id: shopId, ...(metodo === 'get' ? params : corpo) }
        // HTTP 200 NÃO é sucesso: "error" preenchido no corpo é erro de NEGÓCIO (ou de token / reserva de promoção)
        throw new ErroPlataforma(texto, { tipo: reserva !== null ? 'reserva' : (ehToken ? 'token' : 'permanente'), http: r.status || 200, resposta: resumir(data, 4000), requisicao, reserva, dados: data,
          categoria: reserva !== null ? 'reserva_promocao' : (ehToken ? 'autenticacao' : 'negocio') })
      }
      return data
    }
    let token = await getToken(conta)
    if (!token) throw new ErroPlataforma(`${contexto}: loja ${conta.nickname} sem token`, { tipo: 'permanente' })
    try { return await tentar(token) } catch (e) {
      if (!(e instanceof ErroPlataforma) || e.tipo !== 'token') throw e
      token = await refreshToken(conta)
      if (token) conta.access_token = token
      try { return await tentar(token) } catch (e2) { if (e2.tipo === 'token') e2.tipo = 'temporario'; throw e2 } // categoria continua 'autenticacao'
    }
  }

  // "Stock reserved for promotion" (doc da Shopee). null quando não vier — aí NADA é decidido por ele.
  const reservaDe = (x) => {
    const v = x && x.stock_info_v2 && x.stock_info_v2.summary_info ? x.stock_info_v2.summary_info.total_reserved_stock : null
    return v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null
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
    // PRECISA CONFIRMAR: "has_model" — usado SÓ para bloquear envio sem model_id a item que tem variações
    // "bruto" = o objeto como a Shopee devolveu (só para a consulta de diagnóstico; não entra em nenhuma decisão)
    for (const item of ((data && data.response && data.response.item_list) || [])) mapa.set(String(item.item_id), { quantidade: estoqueDe(item), reservada: reservaDe(item), tem_variacao: item.has_model === true, bruto: item })
    return mapa
  }

  // Variações de um item: Map(model_id → { quantidade })
  async function lerModelos(conta, itemId) {
    const data = await chamar(conta, 'get', '/api/v2/product/get_model_list', { params: { item_id: Number(itemId) } }, `Shopee get_model_list ${itemId} (${conta.nickname})`)
    const mapa = new Map()
    // nome/imagem da variação: tier_variation[i].option_list[tier_index[i]] (campos da doc) — só para exibir
    const tiers = (data && data.response && Array.isArray(data.response.tier_variation)) ? data.response.tier_variation : []
    for (const m of ((data && data.response && data.response.model) || [])) {
      const ops = Array.isArray(m.tier_index) ? m.tier_index.map((ix, i) => (tiers[i] && Array.isArray(tiers[i].option_list) ? tiers[i].option_list[ix] : null)) : []
      const nome = ops.filter((o) => o && o.option).map((o) => o.option).join(' / ') || null
      const comImagem = ops.find((o) => o && o.image && o.image.image_url)
      mapa.set(String(m.model_id), { quantidade: estoqueDe(m), reservada: reservaDe(m), bruto: m, nome, imagem: comImagem ? comImagem.image.image_url : null })
    }
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
    const reserva = falhas.length ? reservaDoTexto(motivosFalha(falhas)) : null
    if (falhas.length) throw new ErroPlataforma(`Shopee update_stock ${itemId}${modelId ? '/' + modelId : ''}: recusado · motivo da Shopee: ${motivosFalha(falhas)}`,
      { tipo: reserva !== null ? 'reserva' : 'permanente', reserva, http: 200, dados: data, categoria: reserva !== null ? 'reserva_promocao' : 'negocio', resposta: resumir(data, 4000), requisicao: { metodo: 'POST', path: '/api/v2/product/update_stock', shop_id: shopIdDe(conta), item_id: Number(itemId), stock_list } })
    return { http: 200, resposta: resumir(data), dados: data, requisicao: { metodo: 'POST', path: '/api/v2/product/update_stock', shop_id: shopIdDe(conta), item_id: Number(itemId), stock_list } }
  }

  // Promoções do item (SÓ LEITURA, usado no diagnóstico): Map(item_id → [promoção]); falhas = [{ item_id, failed_reason }].
  // A reserva da promoção vem em promotion_stock_info_v2 — lida nos dois formatos que aparecem na doc; o objeto vai inteiro no "bruto".
  async function lerPromocoes(conta, itemIds) {
    const data = await chamar(conta, 'get', '/api/v2/product/get_item_promotion', { params: { item_id_list: itemIds.join(',') } }, `Shopee get_item_promotion (${conta.nickname})`)
    const r = (data && data.response) || {}
    const mapa = new Map()
    for (const it of (r.success_list || [])) {
      mapa.set(String(it.item_id), (it.promotion || []).map((p) => {
        const v2 = p.promotion_stock_info_v2 || {}
        const res = v2.summary_info && v2.summary_info.total_reserved_stock !== undefined ? v2.summary_info.total_reserved_stock : v2.total_reserved_stock
        return { promotion_type: p.promotion_type ?? null, promotion_id: p.promotion_id ?? null, model_id: p.model_id !== undefined && p.model_id !== null ? String(p.model_id) : null,
          promotion_staging: p.promotion_staging ?? null, start_time: p.start_time ?? null, end_time: p.end_time ?? null,
          reserva: res !== undefined && res !== null && Number.isFinite(Number(res)) ? Number(res) : null, bruto: p }
      }))
    }
    return { mapa, falhas: r.failure_list || [] }
  }

  // Pedidos da loja criados desde uma data (SÓ LEITURA) — mesma chamada do syncShopeeOrders (server.js):
  //   GET /api/v2/order/get_order_list · time_range_field=create_time · janelas de até 15 dias · page_size 50 · cursor
  // Devolve [order_sn]. Acima de maxPaginas, recusa (não dá para conferir tudo).
  async function buscarPedidos(conta, desde, ate = Date.now(), { maxPaginas = 400 } = {}) {
    const sns = []; let paginas = 0
    const fim = Math.floor(ate / 1000)
    for (let ini = Math.floor(new Date(desde).getTime() / 1000); ini < fim; ini += 15 * 86400) {
      const to = Math.min(ini + 15 * 86400, fim)
      let cursor = ''
      for (;;) {
        if (++paginas > maxPaginas) throw new ErroPlataforma(`Shopee pedidos (${conta.nickname}): mais de ${maxPaginas * 50} pedidos no período — não foi possível conferir todos`, { tipo: 'permanente', categoria: 'negocio' })
        const data = await chamar(conta, 'get', '/api/v2/order/get_order_list', { params: { time_range_field: 'create_time', time_from: ini, time_to: to, page_size: 50, cursor } }, `Shopee get_order_list (${conta.nickname})`)
        const r = (data && data.response) || {}
        for (const o of (r.order_list || [])) if (o && o.order_sn) sns.push(String(o.order_sn))
        cursor = r.next_cursor || ''
        if (!(r.more === true && cursor)) break
      }
    }
    return [...new Set(sns)]
  }

  // Detalhe de até 50 pedidos (SÓ LEITURA) — mesma chamada do syncShopeeOrders: get_order_detail com item_list,
  // order_status e fulfillment_flag (subconjunto dos response_optional_fields que o server.js já pede).
  async function detalharPedidos(conta, sns) {
    if (!sns.length) return []
    if (sns.length > 50) throw new Error('detalharPedidos: no máximo 50 por vez')
    const data = await chamar(conta, 'get', '/api/v2/order/get_order_detail', { params: { order_sn_list: sns.join(','), response_optional_fields: 'item_list,order_status,fulfillment_flag,create_time' } }, `Shopee get_order_detail (${conta.nickname})`)
    return ((data && data.response && data.response.order_list) || []).map((o) => ({ sn: String(o.order_sn), status: o.order_status || null,
      fbs: o.fulfillment_flag === 'fulfilled_by_shopee', criado: o.create_time || null,
      // SKU do item: MESMA regra da importação de pedidos (model_sku || item_sku || item_id)
      itens: (o.item_list || []).map((i) => ({ item_id: String(i.item_id), sku: String(i.model_sku || i.item_sku || i.item_id).trim(), qtd: Number(i.model_quantity_purchased) || 1 })) }))
  }

  return { lerItens, lerModelos, enviar, lerPromocoes, ehSandbox, buscarPedidos, detalharPedidos }
}

module.exports = { criarMercadoLivre, criarShopee, ErroPlataforma, classificarErroHttp, resumir, motivosFalha, reservaDoTexto, skuDeclaradoML }
