// Leitura dos dados REAIS de uma empresa para o DRE e os agentes.
// Toda consulta tem .eq(<coluna da empresa>, empresaId) — a empresa vem sempre da sessão (rotas.js), nunca do navegador.
// O Supabase devolve no máximo 1000 linhas por vez: lerTudo() pagina até acabar.
const LOTE = 1000

// Toda leitura paginada termina com .order('id') — ordem única, para nenhuma página pular ou repetir linha.
async function lerTudo(montar, limite = 200000) {
  const linhas = []
  for (let de = 0; ; de += LOTE) {
    if (de >= limite) throw Object.assign(new Error('Volume de dados grande demais para este período. Escolha um período menor.'), { status: 413 })
    const { data, error } = await montar().order('id', { ascending: true }).range(de, de + LOTE - 1)
    if (error) throw new Error(error.message)
    const lote = data || []
    linhas.push(...lote)
    if (lote.length < LOTE) break
  }
  return linhas
}
// .in() com listas grandes vira URL gigante: divide em pedaços
async function lerPorIds(montar, ids, tamanho = 150) {
  const saida = []
  for (let i = 0; i < ids.length; i += tamanho) {
    const parte = ids.slice(i, i + tamanho)
    saida.push(...await lerTudo(() => montar(parte)))
  }
  return saida
}
const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v))

async function pedidosMarketplace(sb, empresaId, ini, fim) {
  return lerTudo(() => sb.from('ml_orders')
    .select('id, ml_order_id, account_nickname, platform, order_type, status, total_amount, sale_fee, shipping_cost_ml, taxes_amount, created_at_ml, items, custos_confirmados')
    .eq('empresa_id', empresaId)
    .gte('created_at_ml', ini.toISOString())
    .lte('created_at_ml', fim.toISOString())
    .neq('status', 'cancelado')) // mesma regra das telas do ERP
}

async function produtos(sb, empresaId) {
  return lerTudo(() => sb.from('products')
    .select('id, sku, name, active, custo_produto, custo_embalagem, custo_frete, imposto_pct, custo_saquinho, custo_outros, estoque_atual, estoque_minimo, estoque_alerta, preco_venda, ml_item_id')
    .eq('empresa_id', empresaId))
}

async function configFinanceira(sb, empresaId) {
  const { data: cfg, error } = await sb.from('config_financeiro').select('imposto_global').eq('empresa_id', empresaId).limit(1).maybeSingle()
  if (error) throw new Error(error.message)
  const { data: desp, error: e2 } = await sb.from('despesas_fixas').select('id, nome, valor, categoria').eq('empresa_id', empresaId).eq('ativo', true)
  if (e2) throw new Error(e2.message)
  return { impostoGlobalPct: num(cfg && cfg.imposto_global), configurado: !!cfg, despesasFixas: desp || [] }
}

async function vendasExternas(sb, empresaId, { ini, fim, de, ate }) {
  const pedidos = await lerTudo(() => sb.from('revenda_pedidos')
    .select('id, numero_pedido, vendedor_id, cliente_id, valor_total, status, created_at, com_nota_fiscal')
    .eq('empresa_id', empresaId)
    .gte('created_at', ini.toISOString())
    .lte('created_at', fim.toISOString())
    .neq('status', 'cancelado'))
  const ids = pedidos.map((p) => p.id)
  const itens = ids.length ? await lerPorIds((parte) => sb.from('revenda_pedido_itens').select('id, pedido_id, produto_id, quantidade, valor_unitario, valor_total, custo_unitario').in('pedido_id', parte), ids) : []
  const comissoes = ids.length ? await lerPorIds((parte) => sb.from('revenda_comissoes').select('pedido_id, vendedor_id, valor_comissao').eq('empresa_id', empresaId).in('pedido_id', parte), ids) : []
  const produtosRev = await lerTudo(() => sb.from('revenda_produtos').select('id, descricao, codigo, estoque, preco_custo, valor_venda, ativo').eq('empresa_id', empresaId))
  const vendedores = await lerTudo(() => sb.from('revenda_vendedores').select('id, nome, user_id, ativo').eq('empresa_id', empresaId))
  const gastos = await lerTudo(() => sb.from('revenda_gastos').select('id, descricao, valor, data, categoria')
    .eq('empresa_id', empresaId).gte('data', de).lte('data', ate))
  const { data: emp, error } = await sb.from('empresas').select('revenda_percentual_nf').eq('id', empresaId).maybeSingle()
  if (error) throw new Error(error.message)
  return { pedidos, itens, comissoes, produtos: produtosRev, vendedores, gastos, percentualNF: num(emp && emp.revenda_percentual_nf) }
}

async function anuncios(sb, empresaId) {
  const ml = await lerTudo(() => sb.from('product_ml_links').select('sku, account_nickname, ml_item_id, quantity').eq('empresa_id', empresaId))
  const shopee = await lerTudo(() => sb.from('product_shopee_links').select('sku, shop_id, item_id, model_id, quantity').eq('empresa_id', empresaId))
  return { ml, shopee }
}

async function financeiro(sb, empresaId) {
  const pagar = await lerTudo(() => sb.from('fin_contas_pagar').select('id, fornecedor, descricao, valor, vencimento, status, categoria')
    .eq('empresa_id', empresaId).in('status', ['pendente', 'vencido']))
  const receber = await lerTudo(() => sb.from('contas_receber').select('id, cliente_nome, valor, data_vencimento, status')
    .eq('tenant_empresa_id', empresaId).in('status', ['a_receber', 'vencido']))
  const contas = await lerTudo(() => sb.from('fin_contas').select('id, nome, tipo, saldo_atual, ativo').eq('empresa_id', empresaId))
  return { pagar, receber, contas: contas.filter((c) => c.ativo !== false) }
}

module.exports = { lerTudo, lerPorIds, pedidosMarketplace, produtos, configFinanceira, vendasExternas, anuncios, financeiro, num }
