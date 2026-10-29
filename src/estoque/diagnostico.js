// Estoque Central — DIAGNÓSTICO ÚNICO (SÓ LEITURA): um relatório consistente ANTES de liberar o agrupamento.
//
// Junta, para os produtos escolhidos (e o grupo de cada um): estoque normal, anúncios (ML/Shopee) lidos AO VIVO, saldo Full,
// reservas da Shopee, divergências abertas CLASSIFICADAS, pedidos não importados (Full/FBS × comuns), vendas sem baixa, riscos
// de baixa duplicada, migrações faltando e modo de envio. Se houver principal, inclui a PRÉVIA do agrupamento — os bloqueios do
// agrupamento são EXATAMENTE os da prévia (mesmas regras, regrasDiagnostico.js), cada um com código, causa e orientação.
//
// NADA é gravado: nenhum saldo, divergência, agrupamento, fila ou configuração muda. Nada é enviado às plataformas.
// Única ação de escrita deste módulo: ignorarDivergenciasFull — só por pedido explícito do administrador, só marca divergências
// como resolvidas ('ignorada_full') depois de CONFIRMAR ao vivo que o anúncio é Full; nunca mexe em estoque.
const { classificarDivergencia, CLASSE_DIVERGENCIA, tipoPedido, LIMITE_PREENCHIMENTO } = require('./regrasDiagnostico')
const ROT = { mercadolivre: 'ML', shopee: 'Shopee' }
const erroHttp = (msg, status) => Object.assign(new Error(msg), { status })
const faltando = (e, nome) => e && (['PGRST202', 'PGRST205', '42P01', '42883'].includes(e.code) || (new RegExp(nome).test(String(e.message || '')) && /(does not exist|Could not find)/i.test(String(e.message || ''))))
const pedacos = (l, n) => { const r = []; for (let i = 0; i < l.length; i += n) r.push(l.slice(i, i + n)); return r }
const JANELA_DIAS = 30

function criarDiagnostico({ sb, ml, grupos, q, lerConfig, envioHabilitado = () => false, agrupamento, ajusteMassa, full, log = console.log, agora = () => new Date() }) {
  const I = agrupamento.interno

  // ── Migrações: o que o backend consegue ver pela API do banco (o resto: SQL de pré-verificação) ─────────────────────
  async function infraestrutura(empresaId) {
    const sonda = async (fn) => { try { const r = await fn(); return r && r.error ? r.error : null } catch (e) { return { message: e.message } } }
    const itens = []
    const add = (mig, item, erro, nome, efeito, orientacao, impedeAgrupar) => itens.push({ mig, item,
      situacao: !erro ? 'aplicada' : faltando(erro, nome) ? 'falta' : 'erro', detalhe: erro ? erro.message || String(erro) : null,
      efeito: !erro ? null : efeito, orientacao: !erro ? null : orientacao, impede_agrupar: !!erro && impedeAgrupar })
    add('21', 'função estoque_anuncio_tem_full', await sonda(() => sb.rpc('estoque_anuncio_tem_full', { p_empresa: empresaId, p_anuncio: '__diagnostico__', p_dias: 1 })), 'estoque_anuncio_tem_full',
      'Sem a 21 não existe Estoque Central (movimentos, fila, divergências).', 'Aplique a migração 21.', true)
    add('22', 'função estoque_anuncios_full', await sonda(() => sb.rpc('estoque_anuncios_full', { p_empresa: empresaId, p_dias: 1 })), 'estoque_anuncios_full',
      'Sem a 22 a conferência de vendas Full usa a função da 21, anúncio por anúncio (mesmo resultado, mais lenta) e a fila grava anúncio por anúncio.',
      'Aplique a 22 depois da pré-verificação (0b/1-26-PRE).', false)
    add('24', 'tabela estoque_ajuste_massa_execucoes', await sonda(() => sb.from('estoque_ajuste_massa_execucoes').select('id').limit(1)), 'estoque_ajuste_massa_execucoes',
      'Sem a 24 o Ajuste em Massa não grava a auditoria e a prévia do agrupamento não consegue conferir os pedidos com a trava.', 'Aplique a 24.', false)
    add('26', 'tabela estoque_agrupamento', await sonda(() => sb.from('estoque_agrupamento').select('id').limit(1)), 'estoque_agrupamento',
      'Sem a 26 não há onde gravar o agrupamento: "Confirmar" falha.', 'Aplique a 26 (depois da 22–25).', true)
    add('27', 'tabela estoque_full_saldos', await sonda(() => sb.from('estoque_full_saldos').select('id').limit(1)), 'estoque_full_saldos',
      'Sem a 27 o saldo Full é lido ao vivo na prévia, mas não fica guardado nem tem histórico na tela "Normal × Full".', 'Aplique a 27 (depois da 26).', false)
    itens.push({ mig: '23 e 25', item: 'índices de divergências (23) e regra de plataforma do ajuste em massa (25)', situacao: 'nao_verificavel',
      detalhe: 'a API do banco não mostra índices/regras', efeito: null, orientacao: 'Confira com 0b-PRE-VERIFICACAO-migracoes-somente-leitura.sql.', impede_agrupar: false })
    return itens
  }

  // Resumo do que levou o estoque normal ao número atual (para negativos/suspeitos): soma por origem, últimos 500 movimentos
  async function origemDoSaldo(empresaId, sku) {
    const m = (await q(sb.from('estoque_movimentos').select('origem, quantidade, aplicado, criado_em').eq('empresa_id', empresaId).eq('sku', sku).order('criado_em', { ascending: false }).limit(500), 'movimentos')) || []
    const porOrigem = {}
    for (const x of m.filter((y) => y.aplicado)) { const o = porOrigem[x.origem] || (porOrigem[x.origem] = { origem: x.origem, movimentos: 0, soma: 0, ultimo: null }); o.movimentos++; o.soma += Number(x.quantidade) || 0; o.ultimo = o.ultimo || x.criado_em }
    return { movimentos_lidos: m.length, nao_aplicados: m.filter((y) => !y.aplicado).length, por_origem: Object.values(porOrigem).sort((a, b) => a.soma - b.soma) }
  }

  async function diagnosticar({ empresaId, skus = [], principal = '', adicionar = null }) {
    const lista = [...new Set((Array.isArray(skus) ? skus : []).map((x) => String(x).trim()).filter(Boolean))]
    const pSku = String(principal || '').trim()
    if (!lista.length && !pSku) throw erroHttp('Informe ao menos um produto (SKU).', 400)
    if (lista.length > 200) throw erroHttp('No máximo 200 produtos por diagnóstico.', 400)
    const inicio = agora()
    const g = await grupos.carregar(empresaId)
    const contas = await I.contasDaEmpresa(empresaId)
    const cat = await I.catalogo(empresaId, g, contas)
    // escopo: os SKUs pedidos + o principal + o grupo de cada um (principal ↔ originais)
    const escopo = new Set([...lista, ...(pSku ? [pSku] : [])])
    for (const x of [...escopo]) { const pr = g.principalDe(x); if (pr) escopo.add(pr); for (const m of g.membros(pr || x)) escopo.add(m.sku_original) }
    const anuncios = [...cat.values()].filter((a) => escopo.has(a.sku_original) || (a.grupo && escopo.has(a.grupo.produto_sku)))
    if (anuncios.length > 200) throw erroHttp(`Os produtos escolhidos têm ${anuncios.length} anúncios — no máximo 200 por diagnóstico. Escolha menos produtos.`, 400)
    const efetivo = (a) => (a.grupo ? a.grupo.produto_sku : a.sku_original)
    const prods = await I.produtosMap(empresaId, [...new Set([...escopo, ...anuncios.map(efetivo)])])
    const cfg = await lerConfig(empresaId)
    const achados = []
    const achar = (tipo, codigo, motivo, orientacao, ref = null) => achados.push({ tipo, codigo, motivo, orientacao, chave: ref })

    // 1) leituras AO VIVO (só GET) — anúncio, Full, vendas Full no histórico
    const vivos = await I.lerAoVivo(anuncios)
    const mlOk = anuncios.filter((a) => a.plataforma === 'mercadolivre' && vivos.get(a.chave) && !vivos.get(a.chave).erro && !(vivos.get(a.chave).variacoes > 0))
    const fulls = full && mlOk.length ? await full.lerAoVivo(mlOk) : new Map()
    let vendasFull = { ids: new Set(), modo: null, erro: null }
    try { vendasFull = { ...(await full.vendasFull(empresaId, anuncios.map((a) => a.anuncio_id))), erro: null } } catch (e) { vendasFull.erro = e.message }

    // 2) produtos (estoque normal)
    const produtos = [...escopo].sort().map((sku) => {
      const p = prods.get(sku)
      const r = { sku, nome: p ? p.name : null, estoque_normal: p ? p.estoque_atual : null, cadastrado: !!p, duplicado: !!(p && p.duplicado),
        agrupado_em: g.principalDe(sku), principal_de: g.membros(sku).length, situacao: 'ok' }
      if (!p) r.situacao = 'nao_cadastrado'
      else if (p.duplicado) r.situacao = 'duplicado'
      else if (p.estoque_atual === null || p.estoque_atual === undefined) r.situacao = 'sem_estoque_oficial'
      else if (Number(p.estoque_atual) < 0) r.situacao = 'negativo'
      else if (Number(p.estoque_atual) >= LIMITE_PREENCHIMENTO) r.situacao = 'suspeito'
      return r
    })
    // importado com número de preenchimento (999+): fica sem estoque oficial e com a marca 'importacao_pendente_contagem'
    const marcaImport = new Set(((await q(sb.from('estoque_movimentos').select('sku').eq('empresa_id', empresaId).eq('origem', 'importacao_pendente_contagem').in('sku', [...escopo]), 'importados pendentes')) || []).map((m) => m.sku))
    for (const r of produtos) if (r.situacao === 'sem_estoque_oficial' && marcaImport.has(r.sku)) r.situacao = 'pendente_contagem'
    for (const r of produtos.filter((x) => ['negativo', 'suspeito'].includes(x.situacao))) r.origem_do_saldo = await origemDoSaldo(empresaId, r.sku)
    for (const r of produtos) {
      const ori = r.origem_do_saldo ? ' Origem (últimos movimentos): ' + (r.origem_do_saldo.por_origem.map((o) => `${o.origem} ${o.soma > 0 ? '+' : ''}${o.soma} em ${o.movimentos}`).join(', ') || 'nenhum movimento registrado — saldo anterior ao Estoque Central') : ''
      if (r.situacao === 'negativo') achar('aviso', 'NORMAL_NEGATIVO', `${r.sku}: estoque normal NEGATIVO (${r.estoque_normal}).${ori}`, 'Vendas baixadas além do que estava registrado (o TMP10 não trava venda real). Conte a peça e use "Revisar contagem" (fica no histórico). Nada é zerado sozinho.', null)
      if (r.situacao === 'suspeito') achar('aviso', 'NORMAL_SUSPEITO', `${r.sku}: estoque normal ${r.estoque_normal} (999 ou mais) — provável número de preenchimento copiado de um anúncio.${ori}`, 'Conte a peça e use "Revisar contagem". Não use esse número como estoque físico.', null)
      if (r.situacao === 'nao_cadastrado') achar('aviso', 'PRODUTO_NAO_CADASTRADO', `${r.sku}: não cadastrado no TMP10`, 'Cadastre ou importe o produto.', null)
      if (r.situacao === 'duplicado') achar('aviso', 'PRODUTO_DUPLICADO', `${r.sku}: mais de um produto com o mesmo SKU — a baixa de venda não acontece (risco de vender sem baixar)`, 'Corrija o cadastro: um produto por SKU.', null)
      if (r.situacao === 'sem_estoque_oficial') achar('aviso', 'SEM_ESTOQUE_OFICIAL', `${r.sku}: sem estoque oficial definido — nenhum envio sai para os anúncios dele`, 'Conte a peça e use "Revisar contagem".', null)
      if (r.situacao === 'pendente_contagem') achar('aviso', 'IMPORTADO_PENDENTE_CONTAGEM', `${r.sku}: importado de um anúncio com 999 ou mais (número de preenchimento) — ficou SEM estoque oficial e nenhum envio sai até a contagem`, 'Conte a peça e use "Revisar contagem" (com o motivo e "Contei fisicamente").', null)
    }

    // 3) anúncios: normal × plataforma × Full × reserva (cada saldo no seu campo)
    const linhasAnuncio = anuncios.map((a) => {
      const v = vivos.get(a.chave) || { erro: 'sem leitura' }
      const f = fulls.get(a.chave) || null
      const p = prods.get(efetivo(a))
      const normal = p && !p.duplicado ? p.estoque_atual : null
      const ehFull = !!((f && f.inventory_id) || vendasFull.ids.has(a.anuncio_id) || (a.plataforma === 'shopee' && v.estoque_shopee > 0))
      let comparacao
      if (v.erro) comparacao = 'erro_leitura'
      else if (ehFull) comparacao = 'full'
      else if (normal === null || normal === undefined) comparacao = 'sem_normal'
      else if (v.quantidade === Math.max(0, Number(normal))) comparacao = 'igual'
      else if (v.reserva > 0 && Number(normal) < v.reserva) comparacao = 'reserva'
      else if (v.quantidade >= LIMITE_PREENCHIMENTO) comparacao = 'preenchimento'
      else comparacao = 'diferente'
      return { chave: a.chave, plataforma: a.plataforma, conta: a.conta_nome, anuncio_id: a.anuncio_id, variacao_id: a.variacao_id || '', sku_vinculo: a.sku_original,
        sku_tmp10: efetivo(a), agrupado_em: a.grupo ? a.grupo.produto_sku : null, conta_conectada: a.conta_conectada,
        normal_tmp10: normal ?? null,
        anunciado: v.erro ? null : v.quantidade, erro_leitura: v.erro || null,
        reserva_shopee: a.plataforma === 'shopee' && !v.erro ? (v.reserva ?? null) : null,
        fbs_shopee: a.plataforma === 'shopee' && !v.erro ? (v.estoque_shopee ?? null) : null,
        full: a.plataforma === 'mercadolivre' ? (f ? { situacao: f.situacao, inventory_id: f.inventory_id || null, disponivel: f.disponivel ?? null, nao_disponivel: f.nao_disponivel ?? null, total: f.total ?? null, erro: f.erro || null } : (v.erro ? { situacao: 'erro', erro: v.erro } : v.variacoes > 0 ? { situacao: 'indisponivel', erro: 'anúncio com variações' } : null)) : null,
        vendas_full_90d: vendasFull.ids.has(a.anuncio_id), comparacao, vinculo_ambiguo: a.ambiguo || (a.outros_skus ? [a.sku_original, ...a.outros_skus] : null) }
    })

    // 4) divergências abertas (classificadas) — a decisão continua sua; nada é resolvido aqui
    const skusDiv = [...escopo]
    const div = skusDiv.length ? ((await q(sb.from('estoque_divergencias').select('id, sku, plataforma, conta_ref, anuncio_id, variacao_id, estoque_tmp10, estoque_ml, ocorrencias, detectado_em, atualizado_em')
      .eq('empresa_id', empresaId).not('chave', 'is', null).not('resolvido', 'is', true).in('sku', skusDiv).limit(500), 'divergências')) || []) : []
    const porChave = new Map(anuncios.map((a) => [`${a.conta_ref}|${a.anuncio_id}|${a.variacao_id || ''}`, a]))
    const divergencias = div.map((d) => {
      const a = porChave.get(`${d.conta_ref}|${d.anuncio_id}|${d.variacao_id || ''}`)
      const v = a ? vivos.get(a.chave) : null
      const f = a ? fulls.get(a.chave) : null
      const p = prods.get(d.sku)
      const c = classificarDivergencia(d, { vivo: v, tmp10Atual: p && !p.duplicado ? p.estoque_atual : null, fullConfirmado: !!(f && f.situacao === 'atualizado' && f.inventory_id) })
      const regra = CLASSE_DIVERGENCIA[c.classe]
      return { id: d.id, sku: d.sku, plataforma: d.plataforma, conta_ref: d.conta_ref, anuncio_id: d.anuncio_id, variacao_id: d.variacao_id || '',
        registrado: { tmp10: d.estoque_tmp10, plataforma: d.estoque_ml, ocorrencias: d.ocorrencias, desde: d.detectado_em, ultima_conferencia: d.atualizado_em },
        agora: { tmp10: p ? p.estoque_atual : null, plataforma: v && !v.erro ? v.quantidade : null, reserva: v && !v.erro ? (v.reserva ?? null) : null, full: f ? f.situacao : null },
        classe: c.classe, bloqueia_agrupamento: c.bloqueia, codigo: regra.codigo, titulo: regra.titulo, orientacao: regra.orientacao, detalhe: c.detalhe || null }
    })

    // 5) pedidos não importados dos anúncios (Full/FBS × comum × não confirmado) e vendas sem baixa
    let pedidos = [], erroPedidos = null
    if (ajusteMassa && ajusteMassa.pedidosPendentes && anuncios.length) {
      const refs = [...new Set(anuncios.map((a) => (a.plataforma === 'shopee' ? 'sh:' : 'ml:') + String(a.conta_ref).replace(/^nick:.*/, '')).filter((r) => !/:$/.test(r)))]
      try {
        const pend = await ajusteMassa.pedidosPendentes(empresaId, refs)
        const ids = new Set(anuncios.map((a) => `${a.plataforma}|${a.anuncio_id}`)); const skusA = new Set(anuncios.map((a) => a.sku_original))
        const afet = pend.naoImportados.filter((pd) => (pd.itens || []).some((it) => skusA.has(it.sku) || ids.has(`${pd.plataforma}|${String(it.anuncio || it.item_id || '')}`)))
        for (const pd of afet.slice(0, 100)) { const t = await tipoPedido(pd, { contas, ml }); pedidos.push({ plataforma: pd.plataforma, pedido: String(pd.id || pd.sn), conta: pd.conta, status: pd.status || null, criado: pd.criado || null,
          tipo: t.full === true ? 'full_fbs' : t.full === false ? 'comum' : 'nao_confirmado', motivo_tipo: t.motivo || null,
          itens: (pd.itens || []).map((it) => ({ sku: it.sku || null, anuncio: it.anuncio || it.item_id || null, qtd: it.qtd || 1 })) }) }
        if (Object.keys(pend.erroConta || {}).length) erroPedidos = Object.values(pend.erroConta).join(' · ')
      } catch (e) { erroPedidos = e.message }
    }
    const desde = new Date(agora().getTime() - JANELA_DIAS * 86400000).toISOString()
    const semBaixa = escopo.size ? ((await q(sb.from('estoque_movimentos').select('sku, referencia, observacao, criado_em').eq('empresa_id', empresaId).eq('aplicado', false)
      .in('origem', ['venda_mercadolivre', 'venda_shopee']).in('sku', [...escopo]).gte('criado_em', desde).limit(200), 'vendas sem baixa')) || []) : []

    // 6) riscos de baixa duplicada / errada
    const riscos = []
    for (const a of anuncios) if (a.ambiguo || a.outros_skus) riscos.push({ codigo: 'VINCULO_AMBIGUO', motivo: `${ROT[a.plataforma]} ${a.anuncio_id}${a.variacao_id ? '/' + a.variacao_id : ''} ligado a mais de um SKU (${[...new Set([...(a.ambiguo || []), a.sku_original, ...(a.outros_skus || [])])].join(', ')}) — a venda pode baixar o produto errado` })
    for (const r of produtos) if (r.duplicado) riscos.push({ codigo: 'PRODUTO_DUPLICADO', motivo: `${r.sku} duplicado no cadastro — vendas dele não baixam (ficam como pendência)` })
    for (const pd of pedidos.filter((x) => x.tipo !== 'full_fbs')) riscos.push({ codigo: 'PEDIDO_PENDENTE', motivo: `pedido ${ROT[pd.plataforma]} ${pd.pedido} ainda não importado (${pd.tipo === 'comum' ? 'venda comum' : 'tipo não confirmado'}) — se o agrupamento mudar antes da importação, a baixa cai no produto errado` })
    for (const r of produtos.filter((x) => x.agrupado_em)) {
      const fora = anuncios.filter((a) => a.sku_original === r.sku && !a.grupo)
      if (fora.length) riscos.push({ codigo: 'SKU_DIVIDIDO', motivo: `${r.sku} está agrupado em ${r.agrupado_em}, mas ${fora.length} anúncio(s) dele estão fora do grupo — a venda deles vira pendência` })
    }
    for (const r of riscos) achar('aviso', r.codigo, r.motivo, r.codigo === 'PEDIDO_PENDENTE' ? 'Aguarde a importação dos pedidos.' : 'Corrija o vínculo/cadastro antes de agrupar.')

    // 7) achados por anúncio que a prévia não cobre (não impedem; explicam números estranhos nas telas)
    for (const l of linhasAnuncio) {
      const nm = `${ROT[l.plataforma]} ${l.conta} ${l.anuncio_id}${l.variacao_id ? '/' + l.variacao_id : ''}`
      if (l.comparacao === 'preenchimento') achar('aviso', 'ANUNCIO_PREENCHIMENTO', `${nm}: o anúncio mostra ${l.anunciado} (número de preenchimento) e o TMP10 tem ${l.normal_tmp10}`, 'O anúncio está oferecendo mais do que existe. Envie o número do TMP10 (quando o SKU estiver autorizado) ou corrija o anúncio na plataforma.', l.chave)
      if (l.comparacao === 'reserva') achar('aviso', 'RESERVA_MAIOR_QUE_TMP10', `${nm}: reserva de promoção da Shopee ${l.reserva_shopee} maior que o TMP10 ${l.normal_tmp10} — a Shopee recusa o número do TMP10`, 'Reduza a reserva ou tire a variação da promoção; depois "Tentar 1 vez".', l.chave)
      if (l.comparacao === 'diferente' && !divergencias.some((d) => d.anuncio_id === l.anuncio_id)) achar('aviso', 'DIFERENCA_SEM_DIVERGENCIA', `${nm}: anúncio ${l.anunciado} × TMP10 ${l.normal_tmp10} — ainda sem divergência registrada`, 'Use "Conferir de novo" (só lê) para registrar e decidir.', l.chave)
    }

    // 8) infraestrutura e modo de envio
    const migracoes = await infraestrutura(empresaId)
    for (const m of migracoes.filter((x) => x.situacao === 'falta' || x.situacao === 'erro')) achar(m.impede_agrupar ? 'bloqueio' : 'aviso', `MIGRACAO_${m.mig}`, `migração ${m.mig} (${m.item}): ${m.situacao === 'falta' ? 'não aplicada' : 'erro ao verificar — ' + m.detalhe}. ${m.efeito}`, m.orientacao)
    if (vendasFull.erro) achar('aviso', 'FULL_VENDAS_FALHOU', `consulta de vendas Full/FBS falhou: ${vendasFull.erro}`, 'Tente de novo; confira as migrações 21/22.')

    // 9) prévia do agrupamento (quando há principal) — os bloqueios do agrupamento são os dela
    let previa = null
    if (pSku) {
      const add = Array.isArray(adicionar) ? adicionar.map(String) : anuncios.filter((a) => a.sku_original !== pSku && !(a.grupo && a.grupo.produto_sku === pSku) && lista.includes(a.sku_original)).map((a) => a.chave)
      if (add.length) {
        try { previa = await agrupamento.previa({ empresaId, produtoSku: pSku, adicionar: add, remover: [] }) } catch (e) { achar('bloqueio', 'PREVIA_FALHOU', `a prévia do agrupamento falhou: ${e.message}`, 'Tente de novo; se persistir, envie esta mensagem.') }
      } else achar('aviso', 'NADA_A_AGRUPAR', 'nenhum anúncio novo para agrupar com esta seleção', 'Escolha os produtos secundários que têm anúncios.')
    }
    const itens = [...(previa ? [...previa.bloqueios, ...previa.alertas] : []), ...achados]
    // sem repetição: mesmo código + mesma mensagem aparece uma vez
    const vistos = new Set(); const unicos = []
    for (const x of itens) { const k = x.codigo + '|' + x.motivo; if (!vistos.has(k)) { vistos.add(k); unicos.push(x) } }
    unicos.sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === 'bloqueio' ? -1 : 1))
    const bloqueios = unicos.filter((x) => x.tipo === 'bloqueio')
    return {
      gerado_em: inicio.toISOString(), duracao_ms: agora().getTime() - inicio.getTime(), somente_leitura: true,
      escopo: { produtos: [...escopo].sort(), anuncios: anuncios.length, principal: pSku || null },
      config: { modo: cfg.modo, skus_piloto: cfg.skus_piloto || [], envio_habilitado_no_servidor: !!envioHabilitado() },
      resumo: { bloqueios: bloqueios.length, avisos: unicos.length - bloqueios.length, pode_agrupar: pSku ? !!(previa && previa.pode_confirmar && !bloqueios.length) : null,
        divergencias: divergencias.length, divergencias_que_bloqueiam: divergencias.filter((d) => d.bloqueia_agrupamento).length,
        pedidos_pendentes: pedidos.length, pedidos_pendentes_comuns: pedidos.filter((p) => p.tipo !== 'full_fbs').length, vendas_sem_baixa: semBaixa.length,
        consulta_vendas_full: vendasFull.erro ? 'erro' : vendasFull.modo === 'lote' ? 'ok (migração 22)' : 'ok (função da 21, anúncio por anúncio — migração 22 ausente)' },
      itens: unicos, produtos, anuncios: linhasAnuncio, divergencias, pedidos, erro_pedidos: erroPedidos,
      vendas_sem_baixa: semBaixa, riscos, migracoes, previa: previa ? { pode_confirmar: previa.pode_confirmar, assinatura: previa.assinatura, quantidade_final: previa.quantidade_final } : null,
      observacao: 'Somente leitura: nenhum saldo, divergência, agrupamento, fila ou configuração foi alterado; nada foi enviado às plataformas.'
    }
  }

  // ── Ação explícita: ignorar divergências de anúncios FULL (confirmado AO VIVO). Não mexe em estoque. ────────────────────
  async function ignorarDivergenciasFull({ empresaId, ids, usuarioId }) {
    const lista = [...new Set((Array.isArray(ids) ? ids : []).map(String))]
    if (!lista.length) throw erroHttp('Escolha as divergências.', 400)
    if (lista.length > 200) throw erroHttp('No máximo 200 por vez.', 400)
    const ds = (await q(sb.from('estoque_divergencias').select('id, sku, plataforma, conta_ref, anuncio_id, variacao_id, resolvido').eq('empresa_id', empresaId).in('id', lista), 'divergências')) || []
    const contas = await I.contasDaEmpresa(empresaId)
    const recusadas = [], ignoradas = []
    for (const id of lista) if (!ds.some((d) => String(d.id) === id)) recusadas.push({ id, motivo: 'não encontrada nesta empresa' })
    const candidatas = []
    for (const d of ds) {
      if (d.resolvido === true) { recusadas.push({ id: d.id, motivo: 'já resolvida' }); continue }
      if (d.plataforma !== 'mercadolivre' || d.variacao_id) { recusadas.push({ id: d.id, motivo: 'só divergências de anúncio do Mercado Livre sem variação' }); continue }
      const conta = contas.find((c) => c.platform !== 'shopee' && c.active === true && (String(d.conta_ref).startsWith('nick:') ? c.nickname === String(d.conta_ref).slice(5) : String(c.ml_user_id) === String(d.conta_ref)))
      if (!conta) { recusadas.push({ id: d.id, motivo: 'conta do anúncio não conectada' }); continue }
      candidatas.push({ d, conta })
    }
    const porConta = new Map(); for (const c of candidatas) { if (!porConta.has(c.conta.id)) porConta.set(c.conta.id, []); porConta.get(c.conta.id).push(c) }
    for (const lote0 of porConta.values()) for (const lote of pedacos(lote0, 20)) {
      let mapa = null, erro = null
      try { mapa = await ml.lerAnuncios(lote[0].conta, [...new Set(lote.map((c) => String(c.d.anuncio_id)))]) } catch (e) { erro = e.message }
      for (const { d } of lote) {
        const l = mapa ? mapa.get(String(d.anuncio_id)) : null
        if (!l || l.erro) { recusadas.push({ id: d.id, motivo: `não foi possível ler o anúncio agora (${(l && l.erro) || erro || 'sem leitura'})` }); continue }
        if (!l.inventory_id) { recusadas.push({ id: d.id, motivo: 'o anúncio NÃO é Full (sem inventory_id) — divergência real, decida no painel' }); continue }
        const r = await sb.from('estoque_divergencias').update({ resolvido: true, resolucao: 'ignorada_full', resolvido_em: agora().toISOString(), resolvido_por: usuarioId || null })
          .eq('id', d.id).eq('empresa_id', empresaId).not('resolvido', 'is', true)
        if (r.error) recusadas.push({ id: d.id, motivo: r.error.message }); else ignoradas.push({ id: d.id, sku: d.sku, anuncio_id: d.anuncio_id, inventory_id: l.inventory_id })
      }
    }
    if (ignoradas.length) log(`🧹 [ESTOQUE] ${ignoradas.length} divergência(s) de anúncio Full ignorada(s) (empresa ${empresaId}, usuário ${usuarioId || '-'}) — nenhum estoque alterado`)
    return { ignoradas, recusadas, observacao: 'Nenhum estoque foi alterado. Só divergências de anúncios confirmados como Full (inventory_id lido agora) foram marcadas como ignoradas.' }
  }

  return { diagnosticar, infraestrutura, ignorarDivergenciasFull }
}

module.exports = { criarDiagnostico }
