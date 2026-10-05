// Agentes do TMP10 — regras sobre os dados REAIS da empresa (funções puras, sem banco).
// Cada agente devolve { visao, alertas }. "alertas" são candidatos: alertas.js grava sem duplicar (chave única).
// Regra de ouro: sem dado → "Dado não disponível" / "É necessário configurar X". Nenhum número é inventado.
const { agrupar, r2 } = require('./dre')
const { somarDias, diaBrasilia } = require('./periodo')

const ND = 'Dado não disponível'
const brl = (v) => 'R$ ' + (Number(v) || 0).toFixed(2).replace('.', ',')
const pct = (v) => (v === null || v === undefined ? '—' : (Number(v) || 0).toFixed(1).replace('.', ',') + '%')
const diaDe = (iso) => diaBrasilia(new Date(iso))
const mesDe = (dia) => dia.slice(0, 7)
const n = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v))

function alerta(tipo, nivel, prioridade, titulo, mensagem, entidade, entidadeId, dados, chave) {
  return { tipo, nivel, prioridade, titulo, mensagem, entidade, entidade_id: entidadeId == null ? null : String(entidadeId), dados: dados || {}, chave }
}
const entre = (linhas, d1, d2) => linhas.filter((l) => { const d = diaDe(l.data); return d >= d1 && d <= d2 })

// Vendas por SKU (quantidade) dentro de uma janela de dias
function qtdPorSku(linhas) {
  const m = new Map()
  for (const l of linhas) for (const i of l.itens) m.set(i.sku, (m.get(i.sku) || 0) + i.quantidade)
  return m
}
function ultimaVendaPor(linhas, chaveDe) {
  const m = new Map()
  for (const l of linhas) for (const i of l.itens) { const k = chaveDe(l, i); if (!k) continue; if (!m.has(k) || m.get(k) < l.data) m.set(k, l.data) }
  return m
}

// ── ETAPA 7 — prejuízo ────────────────────────────────────────────────────────────────────
function agentePrejuizo({ linhas, hoje, diasRecentes = 7 }) {
  const desde = somarDias(hoje, -(diasRecentes - 1))
  const recentes = entre(linhas, desde, hoje)
  const vendas = recentes.filter((l) => l.valores.lucro < -0.005).map((l) => {
    const v = l.valores
    return {
      pedido: l.pedido, origem: l.origem, id: l.id, data: l.data, marketplace: l.marketplace, conta: l.conta,
      produtos: l.itens.map((i) => `${i.quantidade}× ${i.nome}`).join(', '),
      venda: r2(v.faturamento), custo: r2(v.custo_produto), embalagem: r2(v.embalagem), frete: r2(v.frete_marketplace + v.frete_produto),
      taxas: r2(v.comissao), imposto: r2(v.imposto_marketplace + v.imposto_interno), outros: r2(v.outros), publicidade: null,
      lucro: r2(v.lucro), margem: v.faturamento > 0 ? r2(v.lucro / v.faturamento * 100) : null, pendencias: l.pendencias
    }
  })
  const alertas = vendas.map((x) => alerta('prejuizo', 'critico', 95, `🚨 VENDA COM PREJUÍZO — ${x.pedido}`,
    `${x.produtos}. Venda ${brl(x.venda)} · custo ${brl(x.custo)} · taxas ${brl(x.taxas)} · frete ${brl(x.frete)} · imposto ${brl(x.imposto)} · embalagem ${brl(x.embalagem)}` +
    (x.outros ? ` · outros ${brl(x.outros)}` : '') + ` → PREJUÍZO ${brl(-x.lucro)} (margem ${pct(x.margem)}). Publicidade: ${ND.toLowerCase()}.` +
    (x.pendencias.length ? ` Atenção: ${x.pendencias.join('; ')}.` : ''),
    'pedido', x.pedido, x, `prejuizo:${x.origem}:${x.id}`))
  // vendas da janela que NÃO estão (mais) no prejuízo: se havia alerta (ex.: taxa provisória corrigida), ele é resolvido sozinho
  const semPrejuizo = recentes.filter((l) => l.valores.lucro >= -0.005).map((l) => `prejuizo:${l.origem}:${l.id}`)
  return { visao: { dias: diasRecentes, vendas, total_prejuizo: r2(vendas.reduce((s, x) => s - x.lucro, 0)) }, alertas, resolver: semPrejuizo }
}

// ── ETAPA 8 — margem (margem mínima por empresa; sem valor fixo universal) ─────────────────
function agenteMargem({ linhas, hoje, config }) {
  const minima = n(config && config.margem_minima)
  const atual = entre(linhas, somarDias(hoje, -29), hoje)
  const anterior = entre(linhas, somarDias(hoje, -59), somarDias(hoje, -30))
  const prodAnt = new Map(agrupar(anterior, 'produto').map((p) => [p.chave, p]))
  const produtos = agrupar(atual, 'produto').filter((p) => p.faturamento > 0).map((p) => {
    const ant = prodAnt.get(p.chave)
    const qtd = p.quantidade || 1
    // Preço sugerido = custos fixos por unidade ÷ (1 − custos percentuais − margem desejada). Só com custo cadastrado.
    let sugerido = null, motivo = null
    const custoCompleto = !p.pendencias.some((x) => /não cadastrado|custo de/.test(x))
    if (minima === null) motivo = 'É necessário configurar a margem mínima.'
    else if (!custoCompleto) motivo = 'Custo do produto não cadastrado — não dá para calcular.'
    else {
      const fixoUnit = (p.custo + p.frete_marketplace) / qtd
      const pctVar = (p.comissao + p.impostos) / p.faturamento
      const den = 1 - pctVar - minima / 100
      if (den <= 0) motivo = 'Com as taxas atuais, nenhum preço atinge a margem mínima.'
      else sugerido = r2(fixoUnit / den)
    }
    return {
      sku: p.sku, produto: p.rotulo, vendas: p.pedidos, quantidade: p.quantidade, faturamento: p.faturamento, lucro: p.lucro,
      margem_atual: p.margem, margem_anterior: ant ? ant.margem : null, margem_desejada: minima,
      preco_atual: r2(p.faturamento / qtd), preco_sugerido: sugerido, motivo_sem_sugestao: motivo, custo_completo: custoCompleto,
      quantidade_anterior: ant ? ant.quantidade : 0
    }
  })
  const alertas = []
  for (const p of produtos) {
    if (p.margem_atual === null) continue
    if (p.margem_atual < 0) {
      alertas.push(alerta('margem_negativa', 'critico', 90, `🔴 Margem negativa — ${p.produto}`,
        `Últimos 30 dias: ${p.vendas} venda(s), faturamento ${brl(p.faturamento)}, lucro ${brl(p.lucro)} (margem ${pct(p.margem_atual)}).` +
        (p.preco_sugerido ? ` Preço médio ${brl(p.preco_atual)} → sugerido ${brl(p.preco_sugerido)} para margem de ${pct(p.margem_desejada)}.` : (p.motivo_sem_sugestao ? ' ' + p.motivo_sem_sugestao : '')),
        'produto', p.sku, p, `margem_negativa:${p.sku}`))
    } else if (minima !== null && p.custo_completo && p.margem_atual < minima) {
      alertas.push(alerta('margem_baixa', 'atencao', 60, `🟠 Margem abaixo da mínima — ${p.produto}`,
        `Margem ${pct(p.margem_atual)} (desejada ${pct(minima)}). Preço médio ${brl(p.preco_atual)}` +
        (p.preco_sugerido ? ` → sugerido ${brl(p.preco_sugerido)}.` : '. ' + (p.motivo_sem_sugestao || '')) + ' Nenhum preço é alterado automaticamente.',
        'produto', p.sku, p, `margem_baixa:${p.sku}`))
    } else if (minima !== null && p.custo_completo && p.margem_atual >= 2 * minima && p.vendas >= 3 && p.quantidade >= p.quantidade_anterior) {
      alertas.push(alerta('margem_boa', 'oportunidade', 30, `🟢 Margem boa e vendas firmes — ${p.produto}`,
        `Margem ${pct(p.margem_atual)} (mínima ${pct(minima)}) com ${p.quantidade} un. vendidas em 30 dias (antes: ${p.quantidade_anterior}). Pode valer testar um preço um pouco maior ou investir mais neste produto.`,
        'produto', p.sku, p, `margem_boa:${p.sku}`))
    }
  }
  return { visao: { margem_minima: minima, configurar: minima === null, produtos }, alertas }
}

// ── ETAPAS 13 e 14 — estoque e compras ────────────────────────────────────────────────────
function agenteEstoque({ linhas, produtos, hoje, config }) {
  const q30 = qtdPorSku(entre(linhas, somarDias(hoje, -29), hoje))
  const q7 = qtdPorSku(entre(linhas, somarDias(hoje, -6), hoje))
  const cobertura = n(config && config.dias_cobertura_estoque)
  const seguranca = n(config && config.estoque_seguranca_dias)
  const itens = []
  const alertas = []
  for (const p of produtos) {
    if (p.active === false) continue
    const sku = String(p.sku || '').trim()
    const estoque = n(p.estoque_atual)
    const vd30 = (q30.get(sku) || 0) / 30
    const vd7 = (q7.get(sku) || 0) / 7
    const diasEstoque = estoque !== null && vd30 > 0 ? r2(estoque / vd30) : null
    const limite = n(p.estoque_alerta) ?? n(p.estoque_minimo)
    const custo = n(p.custo_produto)
    let compra = null
    if (cobertura !== null && vd30 > 0 && estoque !== null) {
      const qtd = Math.ceil(vd30 * (cobertura + (seguranca || 0)) - estoque)
      if (qtd > 0) compra = { quantidade: qtd, quando: diasEstoque !== null && seguranca !== null ? (diasEstoque <= seguranca ? 'agora' : `em até ${Math.max(0, Math.floor(diasEstoque - seguranca))} dia(s)`) : 'avaliar', custo_esperado: custo ? r2(qtd * custo) : null, fornecedor: ND + ' (o cadastro de produto não tem fornecedor)' }
    }
    const linha = { sku, produto: p.name, estoque, estoque_minimo: limite, vendas_dia: r2(vd30), vendas_dia_7d: r2(vd7), dias_estoque: diasEstoque, previsao_ruptura: diasEstoque !== null ? somarDias(hoje, Math.floor(diasEstoque)) : null, sugestao_compra: compra }
    itens.push(linha)
    if (estoque === null) continue
    if (estoque <= 0 && (vd30 > 0 || limite !== null)) {
      alertas.push(alerta('estoque_zerado', 'critico', 85, `🔴 Estoque zerado — ${p.name}`, `SKU ${sku} está com estoque ${estoque}.` + (vd30 > 0 ? ` Vendia ${r2(vd30)} un./dia nos últimos 30 dias.` : ''), 'produto', sku, linha, `estoque_zerado:${sku}`))
    } else if (limite !== null && estoque <= limite) {
      alertas.push(alerta('estoque_baixo', 'atencao', 65, `🟠 Estoque baixo — ${p.name}`, `SKU ${sku}: ${estoque} un. (mínimo ${limite}).` + (diasEstoque !== null ? ` Dá para ~${diasEstoque} dia(s).` : '') + (compra ? ` Sugestão: comprar ${compra.quantidade} un.` : ''), 'produto', sku, linha, `estoque_baixo:${sku}`))
    } else if (seguranca !== null && diasEstoque !== null && diasEstoque <= seguranca) {
      alertas.push(alerta('risco_ruptura', 'atencao', 70, `🟠 Risco de ruptura — ${p.name}`, `No ritmo atual (${r2(vd30)} un./dia), o estoque de ${estoque} un. acaba em ~${diasEstoque} dia(s) (segurança: ${seguranca} dias).` + (compra ? ` Sugestão: comprar ${compra.quantidade} un.` : ''), 'produto', sku, linha, `risco_ruptura:${sku}`))
    } else if (cobertura !== null && diasEstoque !== null && diasEstoque > 3 * cobertura && estoque > 0) {
      alertas.push(alerta('estoque_excesso', 'atencao', 35, `🟠 Estoque em excesso — ${p.name}`, `${estoque} un. dão para ~${diasEstoque} dias de venda (cobertura desejada: ${cobertura} dias).`, 'produto', sku, linha, `estoque_excesso:${sku}`))
    }
    if (vd30 > 0 && (q7.get(sku) || 0) >= 5 && vd7 >= 2 * vd30) {
      alertas.push(alerta('vendendo_rapido', 'oportunidade', 40, `🟢 Vendendo rápido — ${p.name}`, `Últimos 7 dias: ${r2(vd7)} un./dia, o dobro da média de 30 dias (${r2(vd30)}).` + (diasEstoque !== null ? ` Estoque para ~${r2(estoque / vd7)} dia(s) neste ritmo.` : ''), 'produto', sku, linha, `vendendo_rapido:${sku}`))
    }
  }
  return { visao: { cobertura_dias: cobertura, seguranca_dias: seguranca, configurar_compras: cobertura === null, itens: itens.sort((a, b) => (a.dias_estoque ?? 1e9) - (b.dias_estoque ?? 1e9)) }, alertas }
}

// ── ETAPA 9 — anúncios parados ──────────────────────────────────────────────────────────
function agenteAnunciosParados({ linhas, anuncios, produtos, hoje, config, diasHistorico }) {
  const dias = n(config && config.dias_anuncio_parado) || 30
  const prodMap = new Map(produtos.map((p) => [String(p.sku || '').trim(), p]))
  const ultima = ultimaVendaPor(linhas, (l, i) => (i.anuncio ? `${l.marketplace}:${i.anuncio}` : null))
  const limite = somarDias(hoje, -dias)
  const lista = []
  const add = (marketplace, anuncio, sku, conta) => {
    const p = prodMap.get(String(sku || '').trim())
    if (p && p.active === false) return
    const u = ultima.get(`${marketplace}:${anuncio}`)
    const ultimaDia = u ? diaDe(u) : null
    if (ultimaDia && ultimaDia > limite) return
    lista.push({
      marketplace, anuncio: String(anuncio), sku, conta, produto: p ? p.name : sku, preco: p ? n(p.preco_venda) : null,
      ultima_venda: ultimaDia, dias_sem_venda: ultimaDia ? Math.round((Date.parse(hoje) - Date.parse(ultimaDia)) / 86400000) : null,
      sem_venda_no_historico: !ultimaDia, historico_dias: diasHistorico,
      visualizacoes: ND, cliques: ND, investimento: ND, estoque: p ? n(p.estoque_atual) : null
    })
  }
  for (const a of anuncios.ml || []) add('mercadolivre', a.ml_item_id, a.sku, a.account_nickname)
  for (const a of anuncios.shopee || []) add('shopee', a.item_id, a.sku, 'shop ' + a.shop_id)
  const alertas = lista.map((x) => alerta('anuncio_parado', 'atencao', 45, `🟠 Anúncio sem venda há ${x.dias_sem_venda ?? `mais de ${diasHistorico}`} dias — ${x.produto}`,
    `${x.marketplace === 'shopee' ? 'Shopee' : 'Mercado Livre'} · anúncio ${x.anuncio} (${x.conta}). Última venda: ${x.ultima_venda || `nenhuma nos últimos ${diasHistorico} dias`}. Preço cadastrado: ${x.preco !== null ? brl(x.preco) : ND}. Visualizações, cliques e investimento: ${ND.toLowerCase()} (integração de métricas de anúncio pendente).`,
    'anuncio', `${x.marketplace}:${x.anuncio}`, x, `anuncio_parado:${x.marketplace}:${x.anuncio}`))
  return { visao: { dias_regra: dias, anuncios: lista }, alertas }
}

// ── ETAPA 15 — financeiro ──────────────────────────────────────────────────────────────
function agenteFinanceiro({ financeiro, hoje }) {
  const alertas = []
  const pagarHoje = [], atrasadas = [], receberAtrasado = [], proximos7 = []
  for (const c of financeiro.pagar || []) {
    const v = c.vencimento
    if (!v) continue
    const x = { id: c.id, fornecedor: c.fornecedor, descricao: c.descricao, valor: r2(c.valor), vencimento: v }
    if (v < hoje) { atrasadas.push(x); alertas.push(alerta('conta_atrasada', 'critico', 80, `🔴 Conta atrasada — ${c.fornecedor}`, `${brl(c.valor)} venceu em ${v}${c.descricao ? ' (' + c.descricao + ')' : ''}.`, 'conta_pagar', c.id, x, `conta_atrasada:${c.id}`)) }
    else if (v === hoje) { pagarHoje.push(x); alertas.push(alerta('conta_vence_hoje', 'atencao', 75, `🟠 Conta vence hoje — ${c.fornecedor}`, `${brl(c.valor)} vence hoje${c.descricao ? ' (' + c.descricao + ')' : ''}.`, 'conta_pagar', c.id, x, `conta_vence_hoje:${c.id}`)) }
    else if (v <= somarDias(hoje, 7)) proximos7.push(x)
  }
  for (const c of financeiro.receber || []) {
    if (c.data_vencimento && c.data_vencimento < hoje) {
      const x = { id: c.id, cliente: c.cliente_nome, valor: r2(c.valor), vencimento: c.data_vencimento }
      receberAtrasado.push(x)
      alertas.push(alerta('receber_atrasado', 'atencao', 55, `🟠 Recebimento atrasado — ${c.cliente_nome}`, `${brl(c.valor)} deveria ter sido recebido em ${c.data_vencimento}.`, 'conta_receber', c.id, x, `receber_atrasado:${c.id}`))
    }
  }
  const contas = financeiro.contas || []
  const saldo = contas.length ? r2(contas.reduce((s, c) => s + (n(c.saldo_atual) || 0), 0)) : null
  if (saldo !== null && saldo < 0) alertas.push(alerta('caixa_negativo', 'critico', 88, '🔴 Saldo total das contas negativo', `A soma dos saldos das contas cadastradas é ${brl(saldo)}.`, 'empresa', null, { saldo }, 'caixa_negativo'))
  const soma = (l) => r2(l.reduce((s, x) => s + x.valor, 0))
  return {
    visao: { saldo_contas: saldo, a_pagar_hoje: pagarHoje, atrasadas, a_pagar_7_dias: proximos7, receber_atrasado: receberAtrasado,
      totais: { hoje: soma(pagarHoje), atrasadas: soma(atrasadas), proximos_7_dias: soma(proximos7), receber_atrasado: soma(receberAtrasado) } },
    alertas
  }
}

// ── ETAPA 11 — queda (ou alta) de vendas ─────────────────────────────────────────────────
function agenteVendas({ linhas, produtos, hoje, config }) {
  const limiar = n(config && config.queda_vendas_pct) || 30
  const semanas = []
  for (let s = 0; s < 8; s++) {
    const fim = somarDias(hoje, -7 * s), ini = somarDias(fim, -6)
    const l = entre(linhas, ini, fim)
    semanas.push({ ini, fim, vendas: l.length, faturamento: r2(l.reduce((t, x) => t + x.valores.faturamento, 0)) })
  }
  const atual = semanas[0]
  const hist = semanas.slice(1).filter((s) => s.vendas > 0)
  const visao = { semanas: semanas.slice().reverse(), limiar_pct: limiar, suficiente: false }
  const alertas = []
  if (hist.length < 4) { visao.motivo = 'Histórico insuficiente (são necessárias pelo menos 4 semanas com vendas).'; return { visao, alertas } }
  const media = hist.reduce((s, x) => s + x.vendas, 0) / hist.length
  const dp = Math.sqrt(hist.reduce((s, x) => s + (x.vendas - media) ** 2, 0) / hist.length)
  if (media < 5) { visao.motivo = 'Volume baixo demais para análise estatística (média < 5 vendas/semana).'; return { visao, alertas } }
  const variacao = r2((atual.vendas - media) / media * 100)
  Object.assign(visao, { suficiente: true, media_semanal: r2(media), desvio: r2(dp), atual: atual.vendas, variacao_pct: variacao })
  // Possíveis causas — só o que os dados mostram
  const q7 = qtdPorSku(entre(linhas, atual.ini, atual.fim))
  const qAnt = qtdPorSku(entre(linhas, somarDias(atual.ini, -28), somarDias(atual.ini, -1)))
  const prodMap = new Map(produtos.map((p) => [String(p.sku || '').trim(), p]))
  const causas = []
  const top = [...qAnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  for (const [sku, q] of top) {
    const semanal = q / 4, agora = q7.get(sku) || 0
    const p = prodMap.get(sku)
    if (semanal >= 2 && agora <= semanal * 0.5) {
      const est = p ? n(p.estoque_atual) : null
      causas.push(`${p ? p.name : sku}: caiu de ~${r2(semanal)} para ${agora} un./semana` + (est !== null && est <= 0 ? ' — está SEM ESTOQUE' : ''))
    }
  }
  visao.possiveis_causas = causas.length ? causas : ['Os dados não mostram um produto específico responsável.']
  visao.nao_avaliado = ['concorrência', 'ranking/posicionamento', 'publicidade', 'visualizações'].map((x) => `${x}: ${ND.toLowerCase()}`)
  const quedaForte = variacao <= -limiar && atual.vendas < media - 2 * dp
  if (quedaForte) {
    visao.acoes_sugeridas = ['Conferir estoque dos produtos que pararam de vender', 'Conferir se houve mudança de preço ou anúncio pausado', 'Comparar com a mesma semana do mês anterior']
    alertas.push(alerta('queda_vendas', variacao <= -60 ? 'critico' : 'atencao', variacao <= -60 ? 82 : 68, `${variacao <= -60 ? '🔴' : '🟠'} Queda de vendas: ${pct(-variacao)}`,
      `Últimos 7 dias: ${atual.vendas} vendas. Média das semanas anteriores: ${r2(media)}. Possíveis causas (não confirmadas): ${visao.possiveis_causas.join('; ')}.`,
      'empresa', null, visao, 'queda_vendas'))
  } else if (variacao >= limiar && atual.vendas > media + 2 * dp) {
    alertas.push(alerta('alta_vendas', 'oportunidade', 35, `🟢 Vendas em alta: +${pct(variacao)}`, `Últimos 7 dias: ${atual.vendas} vendas contra média de ${r2(media)}. Bom momento para garantir estoque dos mais vendidos.`, 'empresa', null, visao, 'alta_vendas'))
  }
  return { visao, alertas }
}

// ── ETAPA 16 — vendedores (somente administrador; respeita P13) ─────────────────────────
function agenteVendedores({ linhas, hoje }) {
  const atual = agrupar(entre(linhas, somarDias(hoje, -29), hoje).filter((l) => l.vendedor_id), 'vendedor')
  const ant = new Map(agrupar(entre(linhas, somarDias(hoje, -59), somarDias(hoje, -30)).filter((l) => l.vendedor_id), 'vendedor').map((v) => [v.chave, v]))
  return {
    visao: {
      vendedores: atual.map((v) => {
        const a = ant.get(v.chave)
        return { vendedor_id: v.chave, nome: v.rotulo, vendas: v.pedidos, quantidade: v.quantidade, faturamento: v.faturamento, ticket_medio: v.ticket_medio, comissao: v.comissao, lucro: v.lucro, margem: v.margem,
          faturamento_anterior: a ? a.faturamento : 0, variacao_pct: a && a.faturamento > 0 ? r2((v.faturamento - a.faturamento) / a.faturamento * 100) : null }
      })
    },
    alertas: []
  }
}

// ── ETAPA 12 — publicidade: sem integração de anúncios pagos → nada é inventado ────────────
function agentePublicidade() {
  return { visao: { disponivel: false, mensagem: `${ND}. É necessário integrar a API de Product Ads do Mercado Livre / Shopee Ads (próxima fase) para ver investimento, ROAS e ACOS.` }, alertas: [] }
}

module.exports = { agentePrejuizo, agenteMargem, agenteEstoque, agenteAnunciosParados, agenteFinanceiro, agenteVendas, agenteVendedores, agentePublicidade, ND, brl, pct }
