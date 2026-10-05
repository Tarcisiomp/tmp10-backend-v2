// DRE e LUCRO REAL — cálculo único (funções puras, sem banco).
//
// Fórmula por venda de marketplace (mesmos campos que as telas do ERP já usam):
//   faturamento (total_amount)
//   − comissão do marketplace (sale_fee)
//   − frete pago pelo vendedor (shipping_cost_ml)
//   − imposto informado pelo marketplace (taxes_amount)
//   − imposto interno (config_financeiro.imposto_global % sobre o faturamento)
//   − custo do produto (products.custo_produto × quantidade)
//   − embalagem (products.custo_embalagem + custo_saquinho) × quantidade
//   − frete cadastrado no produto (products.custo_frete) × quantidade
//   − outros custos cadastrados no produto (products.custo_outros) × quantidade
//   = LUCRO DA VENDA
// Venda externa (vendedores): valor_total − custo dos itens (custo_unitario × qtd) − comissão − % de nota fiscal.
// No resumo: − despesas fixas (rateadas por dia) − gastos das vendas externas = LUCRO LÍQUIDO.
//
// Nada é inventado: custo que não está cadastrado entra como PENDÊNCIA (e vale 0 na conta, com aviso).
// Publicidade ainda não vem de nenhuma integração → sempre "Dado não disponível".
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100
const n = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v))

const MARKETPLACES = { mercadolivre: 'Mercado Livre', shopee: 'Shopee', venda_externa: 'Vendas Externas' }
function marketplaceDo(o) {
  return o.platform === 'shopee' || String(o.account_nickname || '').toLowerCase().includes('shopee') ? 'shopee' : 'mercadolivre'
}
function itensDo(o) {
  if (Array.isArray(o.items)) return o.items
  if (typeof o.items === 'string') { try { const a = JSON.parse(o.items); return Array.isArray(a) ? a : [] } catch (e) { return [] } }
  return []
}
function mapaProdutos(produtos) {
  const m = new Map()
  for (const p of produtos || []) m.set(String(p.sku || '').trim(), p)
  return m
}

function zero() {
  return { faturamento: 0, custo_produto: 0, embalagem: 0, frete_produto: 0, outros: 0, comissao: 0, frete_marketplace: 0, imposto_marketplace: 0, imposto_interno: 0, lucro: 0 }
}
function somar(a, b, fator = 1) { for (const k of Object.keys(a)) a[k] += (b[k] || 0) * fator; return a }

// Uma venda de marketplace → linha do DRE (+ fatias por item, para lucro por produto/anúncio)
function calcularPedidoMarketplace(o, prodMap, impostoGlobalPct) {
  const pend = []
  const fat = n(o.total_amount)
  if (fat === null) pend.push('valor da venda não informado')
  const v = zero()
  v.faturamento = fat || 0
  v.comissao = n(o.sale_fee) || 0
  v.frete_marketplace = n(o.shipping_cost_ml) || 0
  v.imposto_marketplace = n(o.taxes_amount) || 0
  if (o.custos_confirmados === false) pend.push('taxas/frete do marketplace ainda provisórios')
  if (impostoGlobalPct === null) pend.push('imposto interno não configurado (Financeiro → Configurações)')
  else v.imposto_interno = v.faturamento * impostoGlobalPct / 100

  const itens = itensDo(o)
  if (!itens.length) pend.push('pedido sem itens')
  const fatias = []
  const partes = itens.length || 1
  for (const it of itens) {
    const sku = String(it.sku || '').trim()
    const qtd = n(it.qty) || 1
    const p = prodMap.get(sku)
    const c = { custo_produto: 0, embalagem: 0, frete_produto: 0, outros: 0 }
    const pendItem = []
    if (!p) pendItem.push(`produto ${sku || '(sem SKU)'} não cadastrado — custo desconhecido`)
    else {
      const cp = n(p.custo_produto)
      if (!cp) pendItem.push(`custo do produto ${sku} não cadastrado`)
      c.custo_produto = (cp || 0) * qtd
      c.embalagem = ((n(p.custo_embalagem) || 0) + (n(p.custo_saquinho) || 0)) * qtd
      c.frete_produto = (n(p.custo_frete) || 0) * qtd
      c.outros = (n(p.custo_outros) || 0) * qtd
    }
    somar(v, c)
    pend.push(...pendItem)
    fatias.push({ sku, nome: it.name || (p && p.name) || sku, quantidade: qtd, anuncio: it.ml_item_id ? String(it.ml_item_id) : null, custos: c, pendencias: pendItem })
  }
  v.lucro = v.faturamento - v.comissao - v.frete_marketplace - v.imposto_marketplace - v.imposto_interno - v.custo_produto - v.embalagem - v.frete_produto - v.outros

  // Fatias por item: valores do pedido divididos igualmente entre os itens (mesma regra das telas do ERP)
  const itensLinha = fatias.map((f) => {
    const x = zero()
    x.faturamento = v.faturamento / partes; x.comissao = v.comissao / partes; x.frete_marketplace = v.frete_marketplace / partes
    x.imposto_marketplace = v.imposto_marketplace / partes; x.imposto_interno = v.imposto_interno / partes
    somar(x, f.custos)
    x.lucro = x.faturamento - x.comissao - x.frete_marketplace - x.imposto_marketplace - x.imposto_interno - x.custo_produto - x.embalagem - x.frete_produto - x.outros
    return { sku: f.sku, nome: f.nome, quantidade: f.quantidade, anuncio: f.anuncio, valores: x, pendencias: f.pendencias }
  })
  const mk = marketplaceDo(o)
  return {
    origem: 'marketplace', id: o.id, pedido: String(o.ml_order_id), data: o.created_at_ml, marketplace: mk, conta: o.account_nickname || 'Sem conta',
    tipo_envio: o.order_type || null, vendedor_id: null, vendedor: null, valores: v, itens: itensLinha, pendencias: [...new Set(pend)]
  }
}

// Uma venda externa (vendedor) → linha do DRE
function calcularPedidoExterno(p, ctx) {
  const pend = []
  const v = zero()
  v.faturamento = n(p.valor_total) || 0
  const itens = ctx.itensPorPedido.get(p.id) || []
  if (!itens.length) pend.push('pedido sem itens')
  const totalItens = itens.reduce((s, i) => s + (n(i.valor_total) || 0), 0)
  const comissao = (ctx.comissoesPorPedido.get(p.id) || 0)
  v.comissao = comissao
  if (ctx.percentualNF === null) pend.push('% de nota fiscal das vendas externas não configurado')
  else v.imposto_interno = v.faturamento * ctx.percentualNF / 100
  const itensLinha = []
  for (const i of itens) {
    const qtd = n(i.quantidade) || 0
    const cu = n(i.custo_unitario)
    const prod = ctx.produtosRev.get(i.produto_id)
    const nome = (prod && prod.descricao) || 'Produto'
    const pendItem = cu === null ? [`custo de "${nome}" não registrado no pedido ${p.numero_pedido}`] : []
    pend.push(...pendItem)
    const custo = (cu || 0) * qtd
    v.custo_produto += custo
    const peso = totalItens > 0 ? (n(i.valor_total) || 0) / totalItens : 1 / itens.length
    const x = zero()
    x.faturamento = v.faturamento * peso; x.comissao = comissao * peso
    x.custo_produto = custo
    itensLinha.push({ sku: 'rev:' + i.produto_id, nome, quantidade: qtd, anuncio: null, valores: x, pendencias: pendItem })
  }
  for (const x of itensLinha) {
    x.valores.imposto_interno = v.imposto_interno * (v.faturamento > 0 ? x.valores.faturamento / v.faturamento : 0)
    x.valores.lucro = x.valores.faturamento - x.valores.custo_produto - x.valores.comissao - x.valores.imposto_interno
  }
  v.lucro = v.faturamento - v.custo_produto - v.comissao - v.imposto_interno
  const vend = ctx.vendedores.get(p.vendedor_id)
  return {
    origem: 'venda_externa', id: p.id, pedido: 'VE-' + p.numero_pedido, data: p.created_at, marketplace: 'venda_externa', conta: 'Vendas Externas',
    tipo_envio: null, vendedor_id: p.vendedor_id, vendedor: vend ? vend.nome : 'Vendedor removido', valores: v, itens: itensLinha, pendencias: [...new Set(pend)]
  }
}

function prepararExternas(ext) {
  const itensPorPedido = new Map(), comissoesPorPedido = new Map()
  for (const i of ext.itens || []) { if (!itensPorPedido.has(i.pedido_id)) itensPorPedido.set(i.pedido_id, []); itensPorPedido.get(i.pedido_id).push(i) }
  for (const c of ext.comissoes || []) comissoesPorPedido.set(c.pedido_id, (comissoesPorPedido.get(c.pedido_id) || 0) + (n(c.valor_comissao) || 0))
  return {
    itensPorPedido, comissoesPorPedido, percentualNF: ext.percentualNF === undefined ? null : ext.percentualNF,
    produtosRev: new Map((ext.produtos || []).map((p) => [p.id, p])), vendedores: new Map((ext.vendedores || []).map((v) => [v.id, v]))
  }
}

// Todas as vendas do período, já calculadas
function calcularVendas({ pedidosMarketplace = [], produtos = [], impostoGlobalPct = null, externas = null }) {
  const prodMap = mapaProdutos(produtos)
  const linhas = pedidosMarketplace.map((o) => calcularPedidoMarketplace(o, prodMap, impostoGlobalPct))
  if (externas) {
    const ctx = prepararExternas(externas)
    for (const p of externas.pedidos || []) linhas.push(calcularPedidoExterno(p, ctx))
  }
  return linhas
}

// Filtros (todos opcionais). A empresa NÃO é filtro: os dados já chegam só da empresa da sessão.
function filtrar(linhas, f = {}) {
  return linhas.filter((l) => {
    if (f.marketplace && l.marketplace !== f.marketplace) return false
    if (f.conta && l.conta !== f.conta) return false
    if (f.vendedor && l.vendedor_id !== f.vendedor) return false
    if (f.tipo_envio && l.tipo_envio !== f.tipo_envio) return false
    if (f.sku && !l.itens.some((i) => i.sku === f.sku)) return false
    if (f.anuncio && !l.itens.some((i) => i.anuncio === f.anuncio)) return false
    return true
  })
}

function formatar(v, qtdPedidos) {
  const taxas = v.comissao + v.frete_marketplace + v.imposto_marketplace + v.imposto_interno
  const custo = v.custo_produto + v.embalagem + v.frete_produto + v.outros
  return {
    faturamento: r2(v.faturamento), custo: r2(custo), custo_produto: r2(v.custo_produto), embalagem: r2(v.embalagem), frete_produto: r2(v.frete_produto), outros: r2(v.outros),
    taxas: r2(taxas), comissao: r2(v.comissao), frete_marketplace: r2(v.frete_marketplace), impostos: r2(v.imposto_marketplace + v.imposto_interno),
    imposto_marketplace: r2(v.imposto_marketplace), imposto_interno: r2(v.imposto_interno),
    publicidade: null, // Dado não disponível: nenhuma integração de publicidade ativa
    lucro: r2(v.lucro), margem: v.faturamento > 0 ? r2(v.lucro / v.faturamento * 100) : null,
    ticket_medio: qtdPedidos ? r2(v.faturamento / qtdPedidos) : null
  }
}

const DIMENSOES = ['pedido', 'produto', 'anuncio', 'marketplace', 'conta', 'vendedor', 'dia']
function agrupar(linhas, dimensao) {
  if (!DIMENSOES.includes(dimensao)) throw Object.assign(new Error('Agrupamento inválido. Use: ' + DIMENSOES.join(', ')), { status: 400 })
  const grupos = new Map()
  const pegar = (chave, rotulo, extra) => {
    if (!grupos.has(chave)) grupos.set(chave, { chave, rotulo, ...extra, pedidos: new Set(), quantidade: 0, v: zero(), pendencias: new Set() })
    return grupos.get(chave)
  }
  for (const l of linhas) {
    if (dimensao === 'produto' || dimensao === 'anuncio') {
      for (const i of l.itens) {
        if (dimensao === 'anuncio' && !i.anuncio) continue
        const chave = dimensao === 'produto' ? i.sku : `${l.marketplace}:${i.anuncio}`
        const g = pegar(chave, i.nome, dimensao === 'produto' ? { sku: i.sku } : { anuncio: i.anuncio, marketplace: l.marketplace, sku: i.sku })
        g.pedidos.add(l.id); g.quantidade += i.quantidade; somar(g.v, i.valores); i.pendencias.forEach((p) => g.pendencias.add(p))
      }
      continue
    }
    let chave, rotulo, extra = {}
    if (dimensao === 'pedido') { chave = l.origem + ':' + l.id; rotulo = l.pedido; extra = { data: l.data, marketplace: l.marketplace, conta: l.conta, vendedor: l.vendedor } }
    else if (dimensao === 'marketplace') { chave = l.marketplace; rotulo = MARKETPLACES[l.marketplace] }
    else if (dimensao === 'conta') { chave = l.marketplace + ':' + l.conta; rotulo = l.conta; extra = { marketplace: l.marketplace } }
    else if (dimensao === 'vendedor') { if (!l.vendedor_id) continue; chave = l.vendedor_id; rotulo = l.vendedor }
    else { chave = new Date(new Date(l.data).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10); rotulo = chave }
    const g = pegar(chave, rotulo, extra)
    g.pedidos.add(l.id); g.quantidade += l.itens.reduce((s, i) => s + i.quantidade, 0); somar(g.v, l.valores); l.pendencias.forEach((p) => g.pendencias.add(p))
  }
  return [...grupos.values()].map((g) => {
    const { v, pedidos, pendencias, ...resto } = g
    return { ...resto, pedidos: pedidos.size, ...formatar(v, pedidos.size), pendencias: [...pendencias] }
  }).sort((a, b) => (dimensao === 'dia' ? a.chave.localeCompare(b.chave) : b.faturamento - a.faturamento))
}

// Resumo do período (o DRE propriamente dito)
function resumo(linhas, { despesasFixas = [], gastosExternos = [], dias = 1, impostoGlobalPct = null } = {}) {
  const v = zero()
  for (const l of linhas) somar(v, l.valores)
  const base = formatar(v, linhas.length)
  const despesasMes = despesasFixas.reduce((s, d) => s + (n(d.valor) || 0), 0)
  const despesasRateadas = despesasMes / 30 * dias
  const gastos = gastosExternos.reduce((s, g) => s + (n(g.valor) || 0), 0)
  const lucroLiquido = v.lucro - despesasRateadas - gastos
  const pendencias = new Map()
  for (const l of linhas) for (const p of l.pendencias) pendencias.set(p, (pendencias.get(p) || 0) + 1)
  return {
    ...base,
    pedidos: linhas.length,
    lucro_operacional: base.lucro,
    despesas_fixas: r2(despesasRateadas), despesas_fixas_mensal: r2(despesasMes), gastos_vendas_externas: r2(gastos),
    despesas: r2(despesasRateadas + gastos),
    lucro: r2(lucroLiquido), margem: v.faturamento > 0 ? r2(lucroLiquido / v.faturamento * 100) : null,
    vendas_com_prejuizo: linhas.filter((l) => l.valores.lucro < 0).length,
    vendas_com_pendencia: linhas.filter((l) => l.pendencias.length).length,
    imposto_global_pct: impostoGlobalPct,
    publicidade: null,
    avisos: [
      'Publicidade: dado não disponível (nenhuma integração de anúncios pagos ativa).',
      ...(impostoGlobalPct === null ? ['Imposto interno não configurado: configure em Financeiro → Configurações.'] : [])
    ],
    pendencias: [...pendencias.entries()].map(([texto, vendas]) => ({ texto, vendas })).sort((a, b) => b.vendas - a.vendas).slice(0, 50)
  }
}

module.exports = { calcularVendas, calcularPedidoMarketplace, filtrar, agrupar, resumo, formatar, marketplaceDo, itensDo, mapaProdutos, DIMENSOES, MARKETPLACES, r2 }
