// Serviço da Central de Inteligência: lê os dados reais da empresa, calcula o DRE, roda os agentes,
// grava alertas e o relatório diário. É o MESMO serviço usado pela tela, pela rotina agendada e pelo assistente de voz.
const dados = require('./dados')
const dre = require('./dre')
const ag = require('./agentes')
const { montarRelatorio } = require('./diretor')
const { resolverPeriodo, diaBrasilia, somarDias, inicioDoDia, fimDoDia } = require('./periodo')
const { criarAlertas, erroBanco, tabelaAusente } = require('./alertas')

const HISTORICO_DIAS = 90
const CONFIG_PADRAO = { margem_minima: null, dias_anuncio_parado: 30, dias_cobertura_estoque: null, estoque_seguranca_dias: null, queda_vendas_pct: 30, push_alertas_criticos: true }
const CATEGORIAS_MEMORIA = ['meta', 'preferencia', 'estrategia', 'produto', 'fornecedor', 'regra', 'limite', 'observacao']
// Memória NÃO guarda segredo nem dado pessoal sensível
const SENSIVEL = /(senha|password|token|secret|segredo|chave\s*(pix|privada|secreta|api)|cart[aã]o\s*de\s*cr[eé]dito|\bcvv\b|\b\d[\d.\-/ ]{9,}\d\b)/i

function criarServico({ sb, envioPush = null, log = console.log, agora = () => new Date() }) {
  const alertas = criarAlertas({ sb, envioPush, log })
  const emExecucao = new Map()

  async function lerConfig(empresaId, { tolerarAusente = true } = {}) {
    const { data, error } = await sb.from('agentes_config').select('*').eq('empresa_id', empresaId).maybeSingle()
    if (error) { if (tolerarAusente && tabelaAusente(error)) return { ...CONFIG_PADRAO, instalado: false }; throw erroBanco(error) }
    return { ...CONFIG_PADRAO, ...(data || {}), instalado: true }
  }

  async function salvarConfig(empresaId, usuarioId, corpo = {}) {
    const limpar = (v, min, max, inteiro) => {
      if (v === null || v === '' || v === undefined) return null
      const x = Number(v)
      if (!isFinite(x) || x < min || x > max) throw Object.assign(new Error(`Valor fora do permitido (${min} a ${max}).`), { status: 400 })
      return inteiro ? Math.round(x) : x
    }
    const linha = { empresa_id: empresaId, atualizado_em: agora().toISOString(), atualizado_por: usuarioId }
    if ('margem_minima' in corpo) linha.margem_minima = limpar(corpo.margem_minima, -100, 100)
    if ('dias_anuncio_parado' in corpo) linha.dias_anuncio_parado = limpar(corpo.dias_anuncio_parado, 1, 365, true) || 30
    if ('dias_cobertura_estoque' in corpo) linha.dias_cobertura_estoque = limpar(corpo.dias_cobertura_estoque, 1, 365, true)
    if ('estoque_seguranca_dias' in corpo) linha.estoque_seguranca_dias = limpar(corpo.estoque_seguranca_dias, 0, 180, true)
    if ('queda_vendas_pct' in corpo) linha.queda_vendas_pct = limpar(corpo.queda_vendas_pct, 5, 95) || 30
    if ('push_alertas_criticos' in corpo) linha.push_alertas_criticos = corpo.push_alertas_criticos !== false
    const { error } = await sb.from('agentes_config').upsert(linha, { onConflict: 'empresa_id' })
    if (error) throw erroBanco(error)
    return lerConfig(empresaId, { tolerarAusente: false })
  }

  // Todas as vendas (marketplace + vendas externas) de uma janela, já calculadas
  async function vendasDaJanela(empresaId, per, { externas = true, marketplace = true } = {}) {
    const [pedidos, produtos, fin] = await Promise.all([
      marketplace ? dados.pedidosMarketplace(sb, empresaId, per.ini, per.fim) : Promise.resolve([]),
      dados.produtos(sb, empresaId),
      dados.configFinanceira(sb, empresaId)
    ])
    const ext = externas ? await dados.vendasExternas(sb, empresaId, per) : null
    const linhas = dre.calcularVendas({ pedidosMarketplace: pedidos, produtos, impostoGlobalPct: fin.impostoGlobalPct, externas: ext })
    return { linhas, produtos, fin, ext }
  }

  // ── DRE ─────────────────────────────────────────────────────────────────────────────
  async function calcularDRE(empresaId, q = {}) {
    const per = resolverPeriodo({ periodo: q.periodo || 'mes', de: q.de, ate: q.ate }, agora())
    const dimensao = q.agrupar || 'marketplace'
    if (!dre.DIMENSOES.includes(dimensao)) throw Object.assign(new Error('Agrupamento inválido. Use: ' + dre.DIMENSOES.join(', ')), { status: 400 })
    const filtros = { marketplace: q.marketplace || null, conta: q.conta || null, vendedor: q.vendedor || null, sku: q.sku || null, anuncio: q.anuncio || null, tipo_envio: q.tipo_envio || null }
    if (filtros.marketplace && !dre.MARKETPLACES[filtros.marketplace]) throw Object.assign(new Error('Marketplace inválido.'), { status: 400 })
    const { linhas, fin, ext } = await vendasDaJanela(empresaId, per, { externas: !filtros.marketplace || filtros.marketplace === 'venda_externa', marketplace: filtros.marketplace !== 'venda_externa' && !filtros.vendedor })
    const filtradas = dre.filtrar(linhas, filtros)
    // despesas fixas e gastos externos só entram no DRE "da empresa toda" (sem filtro de produto/anúncio/conta/vendedor)
    const geral = !filtros.conta && !filtros.vendedor && !filtros.sku && !filtros.anuncio && !filtros.tipo_envio
    const res = dre.resumo(filtradas, {
      despesasFixas: geral && !filtros.marketplace ? fin.despesasFixas : [],
      gastosExternos: geral && (!filtros.marketplace || filtros.marketplace === 'venda_externa') && ext ? ext.gastos : [],
      dias: per.dias, impostoGlobalPct: fin.impostoGlobalPct
    })
    res.produtos_vendidos = filtradas.reduce((s, l) => s + l.itens.reduce((t, i) => t + i.quantidade, 0), 0)
    const opcoes = {
      marketplaces: [...new Set(linhas.map((l) => l.marketplace))].map((m) => ({ valor: m, rotulo: dre.MARKETPLACES[m] })),
      contas: [...new Set(linhas.filter((l) => l.origem === 'marketplace').map((l) => l.conta))].sort(),
      vendedores: ext ? (ext.vendedores || []).map((v) => ({ valor: v.id, rotulo: v.nome })) : [],
      agrupamentos: dre.DIMENSOES
    }
    return { periodo: { tipo: per.periodo, de: per.de, ate: per.ate, dias: per.dias }, filtros, resumo: res, agrupado_por: dimensao, grupos: dre.agrupar(filtradas, dimensao).slice(0, 500), opcoes }
  }

  // ── Agentes + alertas + relatório ─────────────────────────────────────────────────────
  async function rodarAgentes(empresaId, { pushCriticos } = {}) {
    if (emExecucao.has(empresaId)) return emExecucao.get(empresaId)
    const p = (async () => {
      const config = await lerConfig(empresaId, { tolerarAusente: false })
      const hoje = diaBrasilia(agora())
      const per = { ini: inicioDoDia(somarDias(hoje, -(HISTORICO_DIAS - 1))), fim: fimDoDia(hoje), de: somarDias(hoje, -(HISTORICO_DIAS - 1)), ate: hoje, dias: HISTORICO_DIAS }
      const [{ linhas, produtos, fin, ext }, anuncios, financeiro] = await Promise.all([
        vendasDaJanela(empresaId, per), dados.anuncios(sb, empresaId), dados.financeiro(sb, empresaId)
      ])
      const r = {
        prejuizo: ag.agentePrejuizo({ linhas, hoje }),
        margem: ag.agenteMargem({ linhas, hoje, config }),
        estoque: ag.agenteEstoque({ linhas, produtos, hoje, config }),
        anuncios: ag.agenteAnunciosParados({ linhas, anuncios, produtos, hoje, config, diasHistorico: HISTORICO_DIAS }),
        financeiro: ag.agenteFinanceiro({ financeiro, hoje }),
        vendas: ag.agenteVendas({ linhas, produtos, hoje, config }),
        vendedores: ag.agenteVendedores({ linhas, hoje }),
        publicidade: ag.agentePublicidade()
      }
      const candidatos = Object.values(r).flatMap((x) => x.alertas)
      const gravacao = await alertas.registrar(empresaId, candidatos, { pushCriticos: pushCriticos !== undefined ? pushCriticos : config.push_alertas_criticos !== false, resolverChaves: r.prejuizo.resolver || [] })

      const doDia = dre.filtrar(linhas, {}).filter((l) => diaBrasilia(new Date(l.data)) === hoje)
      const doMes = linhas.filter((l) => diaBrasilia(new Date(l.data)) >= hoje.slice(0, 8) + '01')
      const dreHoje = dre.resumo(doDia, { dias: 1, impostoGlobalPct: fin.impostoGlobalPct })
      dreHoje.produtos_vendidos = doDia.reduce((s, l) => s + l.itens.reduce((t, i) => t + i.quantidade, 0), 0)
      const diasMes = Number(hoje.slice(8, 10))
      const inicioMes = hoje.slice(0, 8) + '01'
      const dreMes = dre.resumo(doMes, { despesasFixas: fin.despesasFixas, gastosExternos: ((ext && ext.gastos) || []).filter((g) => g.data >= inicioMes), dias: diasMes, impostoGlobalPct: fin.impostoGlobalPct }) // = /dre?periodo=mes
      const abertos = await alertas.listar(empresaId, { status: 'abertos', limite: 500 })
      const memoria = await listarMemoria(empresaId)
      const relatorio = montarRelatorio({ hoje, dreHoje, dreMes, agentes: r, alertasAbertos: abertos, memoria })
      // Detalhe dos agentes para a tela (listas limitadas, para o relatório não ficar enorme)
      relatorio.detalhes = {
        prejuizo: { ...r.prejuizo.visao, vendas: r.prejuizo.visao.vendas.slice(0, 100) },
        margem: { ...r.margem.visao, produtos: r.margem.visao.produtos.slice().sort((a, b) => (a.margem_atual ?? 0) - (b.margem_atual ?? 0)).slice(0, 100) },
        estoque: { ...r.estoque.visao, itens: r.estoque.visao.itens.slice(0, 150) },
        anuncios: { ...r.anuncios.visao, total: r.anuncios.visao.anuncios.length, anuncios: r.anuncios.visao.anuncios.slice(0, 150) },
        financeiro: r.financeiro.visao,
        vendas: r.vendas.visao,
        vendedores: r.vendedores.visao,
        publicidade: r.publicidade.visao
      }
      const { error } = await sb.from('relatorios_diarios').upsert({ empresa_id: empresaId, data: hoje, conteudo: relatorio, gerado_em: relatorio.gerado_em }, { onConflict: 'empresa_id,data' })
      if (error) throw erroBanco(error)
      log(`[INTELIGENCIA] empresa ${empresaId}: ${candidatos.length} condição(ões), ${gravacao.novos} alerta(s) novo(s), ${gravacao.resolvidos_automaticamente} resolvido(s) automaticamente`)
      return { relatorio, alertas: gravacao, agentes: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.visao])) }
    })()
    emExecucao.set(empresaId, p)
    try { return await p } finally { emExecucao.delete(empresaId) }
  }

  async function relatorioDoDia(empresaId, { maxIdadeMin = 60 } = {}) {
    const hoje = diaBrasilia(agora())
    const { data, error } = await sb.from('relatorios_diarios').select('conteudo, gerado_em').eq('empresa_id', empresaId).eq('data', hoje).maybeSingle()
    if (error) throw erroBanco(error)
    if (data && (agora() - new Date(data.gerado_em)) / 60000 <= maxIdadeMin) return { relatorio: data.conteudo, recalculado: false }
    const r = await rodarAgentes(empresaId)
    return { relatorio: r.relatorio, recalculado: true }
  }

  // ── Memória empresarial ───────────────────────────────────────────────────────────────
  async function listarMemoria(empresaId) {
    const { data, error } = await sb.from('memoria_empresa').select('id, categoria, titulo, conteudo, criado_em, atualizado_em').eq('empresa_id', empresaId).order('categoria', { ascending: true }).limit(500)
    if (error) throw erroBanco(error)
    return data || []
  }
  function validarMemoria(corpo) {
    const categoria = String(corpo.categoria || '').trim()
    const titulo = String(corpo.titulo || '').trim().slice(0, 120)
    const conteudo = String(corpo.conteudo || '').trim().slice(0, 2000)
    if (!CATEGORIAS_MEMORIA.includes(categoria)) throw Object.assign(new Error('Categoria inválida. Use: ' + CATEGORIAS_MEMORIA.join(', ')), { status: 400 })
    if (!titulo || !conteudo) throw Object.assign(new Error('Preencha título e conteúdo.'), { status: 400 })
    if (SENSIVEL.test(titulo + ' ' + conteudo)) throw Object.assign(new Error('A memória não guarda senhas, tokens, chaves, números de cartão ou documentos. Remova esse dado.'), { status: 400 })
    return { categoria, titulo, conteudo }
  }
  async function criarMemoria(empresaId, usuarioId, corpo) {
    const m = validarMemoria(corpo)
    const atuais = await listarMemoria(empresaId)
    if (atuais.length >= 200) throw Object.assign(new Error('Limite de 200 itens de memória por empresa.'), { status: 400 })
    const t = agora().toISOString()
    const { data, error } = await sb.from('memoria_empresa').insert({ empresa_id: empresaId, ...m, criado_por: usuarioId, criado_em: t, atualizado_em: t }).select('id, categoria, titulo, conteudo, criado_em, atualizado_em').maybeSingle()
    if (error) throw erroBanco(error)
    return data
  }
  async function alterarMemoria(empresaId, id, corpo) {
    const m = validarMemoria(corpo)
    const { data: alvo, error: e1 } = await sb.from('memoria_empresa').select('id').eq('empresa_id', empresaId).eq('id', id).maybeSingle()
    if (e1) throw erroBanco(e1)
    if (!alvo) throw Object.assign(new Error('Item não encontrado.'), { status: 404 })
    const { error } = await sb.from('memoria_empresa').update({ ...m, atualizado_em: agora().toISOString() }).eq('empresa_id', empresaId).eq('id', id)
    if (error) throw erroBanco(error)
    return true
  }
  async function apagarMemoria(empresaId, id) {
    const { data: alvo, error: e1 } = await sb.from('memoria_empresa').select('id').eq('empresa_id', empresaId).eq('id', id).maybeSingle()
    if (e1) throw erroBanco(e1)
    if (!alvo) throw Object.assign(new Error('Item não encontrado.'), { status: 404 })
    const { error } = await sb.from('memoria_empresa').delete().eq('empresa_id', empresaId).eq('id', id)
    if (error) throw erroBanco(error)
    return true
  }

  return { calcularDRE, rodarAgentes, relatorioDoDia, lerConfig, salvarConfig, listarMemoria, criarMemoria, alterarMemoria, apagarMemoria, alertas, CONFIG_PADRAO }
}

module.exports = { criarServico, CATEGORIAS_MEMORIA, SENSIVEL }
