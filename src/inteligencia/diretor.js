// ETAPAS 17 e 18 — Agente Diretor e Relatório Diário.
// Consolida os outros agentes e o DRE. Todo texto sai de números calculados; sem dado → diz que não tem.
const { brl, pct, ND } = require('./agentes')

const PESO = { critico: 3, atencao: 2, oportunidade: 1 }

// Números de hoje e do mês (vêm dos indicadores oficiais — os mesmos do Painel Executivo)
function blocoNumeros(dreHoje, dreMes) {
  return {
    hoje: { faturamento: dreHoje.faturamento, lucro: dreHoje.lucro_operacional, margem: dreHoje.faturamento ? Math.round(dreHoje.lucro_operacional / dreHoje.faturamento * 10000) / 100 : null, vendas: dreHoje.pedidos },
    mes: { faturamento: dreMes.faturamento, lucro: dreMes.lucro, margem: dreMes.margem, vendas: dreMes.pedidos, despesas: dreMes.despesas },
    produtos_vendidos_hoje: dreHoje.produtos_vendidos || 0
  }
}
function frasesNumeros(dreHoje, dreMes) {
  return [
    dreHoje.pedidos
      ? `Hoje: ${dreHoje.pedidos} venda(s), faturamento ${brl(dreHoje.faturamento)}, lucro das vendas ${brl(dreHoje.lucro_operacional)} (margem ${pct(dreHoje.faturamento ? dreHoje.lucro_operacional / dreHoje.faturamento * 100 : null)}).`
      : 'Hoje ainda não há vendas registradas.',
    `No mês: ${dreMes.pedidos} venda(s), faturamento ${brl(dreMes.faturamento)}, lucro líquido ${brl(dreMes.lucro)} (margem ${pct(dreMes.margem)}) já descontando despesas fixas rateadas (${brl(dreMes.despesas_fixas)}).`
  ]
}
// Relatório guardado (análise de até 60 min) com os números de hoje/mês do MOMENTO
function atualizarNumeros(relatorio, dreHoje, dreMes) {
  const r = { ...relatorio, numeros: { ...(relatorio.numeros || {}), ...blocoNumeros(dreHoje, dreMes) }, numeros_em: new Date().toISOString() }
  const frases = frasesNumeros(dreHoje, dreMes)
  r.o_que_esta_acontecendo = [...frases, ...((relatorio.o_que_esta_acontecendo || []).slice(2))]
  return r
}

function montarRelatorio({ hoje, dreHoje, dreMes, agentes, alertasAbertos = [], memoria = [] }) {
  const { prejuizo, margem, estoque, anuncios, financeiro, vendas, publicidade } = agentes
  const ordenados = alertasAbertos.slice().sort((a, b) => (PESO[b.nivel] - PESO[a.nivel]) || (b.prioridade - a.prioridade))
  const ruins = ordenados.filter((a) => a.nivel !== 'oportunidade')
  const oportunidades = ordenados.filter((a) => a.nivel === 'oportunidade')

  const estoqueBaixo = estoque.alertas.filter((a) => ['estoque_baixo', 'risco_ruptura', 'estoque_zerado'].includes(a.tipo))
  const acontecendo = [...frasesNumeros(dreHoje, dreMes)]
  if (vendas.visao.suficiente) acontecendo.push(`Últimos 7 dias: ${vendas.visao.atual} vendas (média semanal ${vendas.visao.media_semanal}; variação ${pct(vendas.visao.variacao_pct)}).`)
  else acontecendo.push(`Tendência de vendas: ${vendas.visao.motivo}`)

  const configurar = []
  if (margem.visao.configurar) configurar.push('Margem mínima (Central → Configurar) — sem ela o agente de margem não avisa.')
  if (estoque.visao.configurar_compras) configurar.push('Dias de cobertura de estoque — sem isso não há sugestão de compra.')
  if (dreMes.imposto_global_pct === null) configurar.push('Imposto interno (Financeiro → Configurações).')
  if (dreMes.vendas_com_pendencia) configurar.push(`${dreMes.vendas_com_pendencia} venda(s) do mês com custo pendente — cadastre o custo dos produtos.`)

  const prioridades = ruins.slice(0, 3).map((a, i) => ({ ordem: i + 1, nivel: a.nivel, titulo: a.titulo, mensagem: a.mensagem, alerta_id: a.id }))
  const tarefas = ruins.slice(0, 10).map((a) => ({ titulo: a.titulo, alerta_id: a.id, nivel: a.nivel }))
  configurar.forEach((c) => tarefas.push({ titulo: 'Configurar: ' + c, alerta_id: null, nivel: 'atencao' }))

  return {
    titulo: 'RELATÓRIO DIÁRIO TMP10',
    data: hoje,
    gerado_em: new Date().toISOString(),
    numeros: {
      ...blocoNumeros(dreHoje, dreMes),
      prejuizos_7_dias: { vendas: prejuizo.visao.vendas.length, total: prejuizo.visao.total_prejuizo },
      anuncios_parados: anuncios.visao.anuncios.length,
      estoque_baixo: estoqueBaixo.length,
      publicidade: publicidade.visao.disponivel ? null : ND,
      contas: financeiro.visao.totais,
      saldo_contas: financeiro.visao.saldo_contas
    },
    o_que_esta_acontecendo: acontecendo,
    o_que_esta_ruim: ruins.filter((a) => a.nivel === 'critico').slice(0, 5).map((a) => a.titulo),
    precisa_de_atencao: ruins.filter((a) => a.nivel === 'atencao').slice(0, 5).map((a) => a.titulo),
    prioridades,
    oportunidades: oportunidades.slice(0, 5).map((a) => ({ titulo: a.titulo, mensagem: a.mensagem })),
    tarefas,
    configurar,
    contexto_da_empresa: memoria.filter((m) => ['meta', 'limite', 'estrategia', 'regra'].includes(m.categoria)).slice(0, 10).map((m) => ({ categoria: m.categoria, titulo: m.titulo, conteudo: m.conteudo })),
    contagem_alertas: { critico: ruins.filter((a) => a.nivel === 'critico').length, atencao: ruins.filter((a) => a.nivel === 'atencao').length, oportunidade: oportunidades.length }
  }
}

module.exports = { montarRelatorio, atualizarNumeros, blocoNumeros }
