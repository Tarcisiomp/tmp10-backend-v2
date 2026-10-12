// Estoque Central — AJUSTE EM MASSA (Marketplace → TMP10), 1ª versão: SÓ MERCADO LIVRE.
//
// O que faz: o usuário escolhe uma conta do ML e os SKUs; a SIMULAÇÃO lê AO VIVO todos os anúncios vinculados a cada SKU,
// confere vínculos e pedidos e diz, por SKU, se o número do ML pode virar o estoque oficial do TMP10. A EXECUÇÃO só aceita uma
// simulação válida, revalida tudo item a item e grava pelo caminho oficial (estoque_movimentar), com referência idempotente
// massa:{execução}:{sku}. Os anúncios do SKU entram na fila que já existe (que respeita PILOTO/ATIVO/DESLIGADO). Nunca envia
// nada ao ML/Shopee daqui.
//
// Regras (todas BLOQUEIAM o SKU; nada é somado; nada é vinculado por nome):
//   • produto inexistente, duplicado ou sem estoque oficial · sem anúncio vinculado na conta de origem
//   • SKU com anúncio na Shopee ou com venda na Shopee nos últimos 30 dias (nesta versão só SKUs exclusivos do ML)
//   • conta de algum vínculo não conectada · vínculo com variação (ml_variation_id) ou "não sincronizar"
//   • anúncio ligado a mais de um SKU · anúncio com variações · leitura com erro
//   • SKU declarado no anúncio (SELLER_SKU → seller_custom_field) diferente do SKU do vínculo
//   • anúncios do SKU com números diferentes ("Anúncios discordam") — anúncios Full não entram na comparação nem servem de origem
//   • número acima do LIMITE provisório (padrão 999): revisão manual (o limite NÃO confirma que números menores estão certos)
//   • pedidos: (A) pedido ML paid/payment_in_process/confirmed ainda não importado; (B) venda importada sem baixa ou registrada
//     com outro SKU no mesmo anúncio; (C) pedido ML cancelado/invalidado no ML e ainda aberto no TMP10; (D) falha ao consultar.
const crypto = require('crypto')

const LIMITE_SKUS = 100
const LIMITE_QUANTIDADE_PADRAO = 999
const VALIDADE_MINUTOS = 60
const JANELA_DIAS = 30
const STATUS_PEDIDOS_ML = ['paid', 'payment_in_process', 'confirmed']   // confirmed: doc oficial do ML (desconta estoque)
const STATUS_ML_CANCELADO = ['cancelled', 'invalid']
const MAX_PEDIDOS_CANCELAMENTO_POR_SKU = 60
const TRAVA_SEGUNDOS = 120
const AVISO_FIXO = 'Pedidos do ML em payment_required/partially_paid não são verificados: a documentação oficial não confirma se descontam o estoque.'
const ehUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''))
const erroHttp = (msg, status) => Object.assign(new Error(msg), { status })

function criarAjusteMassa({ sb, ml, q, rpc, movimentar, lerConfig, decidirEnvio, log = console.log, limiteQuantidade = LIMITE_QUANTIDADE_PADRAO,
  agora = () => new Date(), dormir = () => Promise.resolve() }) {
  const dono = `tmp10-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const jobs = new Map()          // execucao_id → { tipo, fase, processados, total, erro, iniciado_em, terminado_em }
  const executandoEmpresa = new Set()

  async function lerTodos(montar, contexto) {
    const todos = []
    for (let de = 0; ; de += 1000) {
      const lote = await q(montar().range(de, de + 999), contexto)
      todos.push(...(lote || []))
      if (!lote || lote.length < 1000) return todos
    }
  }
  const pedacos = (lista, n) => { const r = []; for (let i = 0; i < lista.length; i += n) r.push(lista.slice(i, i + n)); return r }
  const contaRefDe = (c) => String(c.ml_user_id)
  async function contasML(empresaId) {
    const contas = await q(sb.from('ml_accounts').select('id, nickname, ml_user_id, platform, active, empresa_id, access_token, refresh_token, expires_at').eq('empresa_id', empresaId), 'contas')
    return (contas || []).filter((c) => c.platform !== 'shopee' && c.active === true)
  }
  const contaDoLink = (contas, l) => {
    const achadas = contas.filter((c) => (l.ml_user_id ? String(c.ml_user_id) === String(l.ml_user_id) : c.nickname === l.account_nickname))
    return achadas.length === 1 ? achadas[0] : null
  }
  async function anunciosFull(empresaId, ids) {
    try {
      const r = await rpc('estoque_anuncios_full', { p_empresa: empresaId, p_dias: 90 })
      return new Set((r || []).map((x) => String(typeof x === 'object' && x !== null ? Object.values(x)[0] : x)))
    } catch (e) { // sem a migração 22: consulta um a um (mesma regra)
      const s = new Set()
      for (const id of ids) if (await rpc('estoque_anuncio_tem_full', { p_empresa: empresaId, p_anuncio: id, p_dias: 90 })) s.add(id)
      return s
    }
  }

  // ── Avaliação de um conjunto de SKUs (usada pela SIMULAÇÃO e de novo pela EXECUÇÃO) ─────────────────────────────────
  // Ordem: 1) banco  2) leitura AO VIVO dos anúncios  3) DEPOIS, pedidos (assim toda venda que já pode estar no número lido
  // aparece na consulta de pedidos). Devolve Map(sku → avaliação).
  async function avaliar(empresaId, skus, contaOrigem, progresso = () => {}) {
    const res = new Map()
    const bloquear = (sku, motivo, extra = {}) => { const r = res.get(sku); if (r && r.situacao !== 'bloqueado') { r.situacao = 'bloqueado'; r.motivo = motivo; Object.assign(r, extra) } }
    for (const sku of skus) res.set(sku, { sku, situacao: 'pendente', motivo: null, anuncios: [], avisos: [], pedidos: [] })

    // 1) banco
    const prods = await lerTodos(() => sb.from('products').select('id, sku, name, estoque_atual').eq('empresa_id', empresaId).in('sku', skus), 'produtos')
    const links = await lerTodos(() => sb.from('product_ml_links').select('sku, account_nickname, ml_item_id, ml_user_id, sincronizar, ml_variation_id').eq('empresa_id', empresaId).in('sku', skus), 'vínculos ML')
    const linksSh = await lerTodos(() => sb.from('product_shopee_links').select('sku, shop_id, item_id').eq('empresa_id', empresaId).in('sku', skus), 'vínculos Shopee')
    const ids = [...new Set(links.map((l) => String(l.ml_item_id)).filter(Boolean))]
    const outros = ids.length ? await lerTodos(() => sb.from('product_ml_links').select('sku, ml_item_id').eq('empresa_id', empresaId).in('ml_item_id', ids), 'vínculos do anúncio') : []
    const skusDoAnuncio = new Map()
    for (const o of outros) { const k = String(o.ml_item_id); if (!skusDoAnuncio.has(k)) skusDoAnuncio.set(k, new Set()); skusDoAnuncio.get(k).add(o.sku) }
    const contas = await contasML(empresaId)
    const full = await anunciosFull(empresaId, ids)

    for (const sku of skus) {
      const r = res.get(sku)
      const ps = prods.filter((p) => p.sku === sku)
      if (ps.length !== 1) { bloquear(sku, ps.length ? 'mais de um produto com este SKU no cadastro' : 'produto não cadastrado no TMP10'); continue }
      r.produto_id = ps[0].id; r.nome = ps[0].name; r.tmp10 = ps[0].estoque_atual
      if (r.tmp10 === null || r.tmp10 === undefined) { bloquear(sku, 'produto sem estoque oficial definido no TMP10'); continue }
      const meus = links.filter((l) => l.sku === sku && l.ml_item_id)
      r.anuncios = meus.map((l) => { const c = contaDoLink(contas, l); return { conta_ref: l.ml_user_id ? String(l.ml_user_id) : `nick:${l.account_nickname}`, conta: c ? c.nickname : l.account_nickname, anuncio_id: String(l.ml_item_id), full: full.has(String(l.ml_item_id)), _link: l, _conta: c } })
      if (!meus.some((l) => { const c = contaDoLink(contas, l); return c && contaRefDe(c) === contaRefDe(contaOrigem) })) { bloquear(sku, `sem anúncio vinculado na conta de origem ${contaOrigem.nickname}`); continue }
      if (linksSh.some((l) => l.sku === sku)) { bloquear(sku, 'SKU também tem anúncio na Shopee — nesta versão o ajuste em massa só trata SKUs vendidos apenas no Mercado Livre'); continue }
      const semConta = r.anuncios.find((a) => !a._conta); if (semConta) { bloquear(sku, `conta ${semConta.conta} do anúncio ${semConta.anuncio_id} não está conectada/ativa — não dá para conferir`); continue }
      const comVar = r.anuncios.find((a) => a._link.ml_variation_id); if (comVar) { bloquear(sku, `vínculo com variação no anúncio ${comVar.anuncio_id} — fora desta versão`); continue }
      const naoSinc = r.anuncios.find((a) => a._link.sincronizar === false); if (naoSinc) { bloquear(sku, `vínculo do anúncio ${naoSinc.anuncio_id} marcado para não sincronizar`); continue }
      const amb = r.anuncios.find((a) => (skusDoAnuncio.get(a.anuncio_id) || new Set()).size > 1)
      if (amb) { bloquear(sku, `anúncio ${amb.anuncio_id} está ligado a mais de um SKU (${[...skusDoAnuncio.get(amb.anuncio_id)].join(', ')}) — vínculo ambíguo`); continue }
    }

    // 2) leitura AO VIVO (por conta, até 20 por chamada) — só dos SKUs ainda pendentes
    const porConta = new Map()
    for (const r of res.values()) if (r.situacao === 'pendente') for (const a of r.anuncios) {
      if (!porConta.has(a._conta.id)) porConta.set(a._conta.id, { conta: a._conta, ids: new Set() })
      porConta.get(a._conta.id).ids.add(a.anuncio_id)
    }
    const leitura = new Map()   // `${contaId}:${anuncio}` → leitura
    for (const { conta, ids: idsConta } of porConta.values()) {
      for (const lote of pedacos([...idsConta], 20)) {
        let mapa = null, erro = null
        try { mapa = await ml.lerAnuncios(conta, lote) } catch (e) { erro = e.message }
        for (const id of lote) leitura.set(`${conta.id}:${id}`, mapa ? (mapa.get(id) || { erro: 'anúncio não devolvido pelo ML' }) : { erro })
        await dormir()
      }
    }
    const lidoEm = agora().toISOString()
    for (const r of res.values()) {
      if (r.situacao !== 'pendente') continue
      for (const a of r.anuncios) {
        const l = leitura.get(`${a._conta.id}:${a.anuncio_id}`) || { erro: 'sem leitura' }
        Object.assign(a, { quantidade: l.erro ? null : l.quantidade, erro: l.erro || null, titulo: l.titulo ?? null, sku_declarado: l.sku_declarado ?? null, variacoes: l.variacoes || 0, lido_em: lidoEm })
      }
      const comErro = r.anuncios.find((a) => a.erro || a.quantidade === null); if (comErro) { bloquear(r.sku, `falha ao ler o anúncio ${comErro.anuncio_id}: ${comErro.erro || 'sem quantidade'}`); continue }
      const comVar = r.anuncios.find((a) => a.variacoes > 0); if (comVar) { bloquear(r.sku, `anúncio ${comVar.anuncio_id} tem ${comVar.variacoes} variação(ões) no ML — o número é a soma das variações`); continue }
      const skuErrado = r.anuncios.find((a) => (a.sku_declarado || a.anuncio_id) !== r.sku)
      if (skuErrado) { bloquear(r.sku, `anúncio ${skuErrado.anuncio_id} declara o SKU "${skuErrado.sku_declarado || '(nenhum: usa o código do anúncio)'}", diferente do vínculo "${r.sku}"`); continue }
      const comparaveis = r.anuncios.filter((a) => !a.full)
      const daOrigem = comparaveis.filter((a) => contaRefDe(a._conta) === contaRefDe(contaOrigem))
      if (!daOrigem.length) { bloquear(r.sku, 'o anúncio da conta de origem é Full (estoque no armazém do ML) — não serve de origem'); continue }
      const numeros = [...new Set(comparaveis.map((a) => a.quantidade))]
      if (numeros.length > 1) { bloquear(r.sku, 'Anúncios discordam: ' + comparaveis.map((a) => `${a.conta} ${a.anuncio_id} = ${a.quantidade}`).join(' · ')); continue }
      r.numero_lido = numeros[0]; r.anuncio_origem = daOrigem[0].anuncio_id
      if (!Number.isInteger(r.numero_lido) || r.numero_lido < 0) { bloquear(r.sku, `número inválido no anúncio (${r.numero_lido})`); continue }
      if (r.numero_lido > limiteQuantidade) { bloquear(r.sku, `número do anúncio (${r.numero_lido}) acima do limite provisório de ${limiteQuantidade} — revisão manual (pode ser número de preenchimento, não estoque físico)`); continue }
      if (r.numero_lido === Math.max(0, Number(r.tmp10)) && Number(r.tmp10) >= 0) { r.situacao = 'igual'; r.motivo = 'o TMP10 já tem este número'; continue }
      r.situacao = 'apto'; r.novo = r.numero_lido
    }
    progresso('leitura')

    // 3) pedidos — só para os aptos
    const aptos = [...res.values()].filter((r) => r.situacao === 'apto')
    if (aptos.length) await verificarPedidos(empresaId, aptos, bloquear)
    for (const r of res.values()) {
      r.avisos.push(AVISO_FIXO)
      for (const a of r.anuncios) { delete a._link; delete a._conta }
    }
    return res
  }

  async function verificarPedidos(empresaId, aptos, bloquear) {
    const desde = new Date(agora().getTime() - JANELA_DIAS * 86400000)
    const contas = await contasML(empresaId)
    const anunciosDe = new Map(aptos.map((r) => [r.sku, new Set(r.anuncios.map((a) => a.anuncio_id))]))
    const afeta = (r, item) => item && ((item.sku && item.sku === r.sku) || (item.anuncio && anunciosDe.get(r.sku).has(String(item.anuncio))))
    // contas envolvidas = contas dos anúncios dos aptos
    const refs = new Set(aptos.flatMap((r) => r.anuncios.map((a) => a.conta_ref)))
    const contasEnv = contas.filter((c) => refs.has(contaRefDe(c)) || refs.has(`nick:${c.nickname}`))

    // A) pedidos no ML ainda não importados (mesma busca do syncMLOrders + status confirmed)
    for (const conta of contasEnv) {
      let pedidos = []
      try {
        for (const st of STATUS_PEDIDOS_ML) pedidos.push(...await ml.buscarPedidos(conta, st, desde))
      } catch (e) {
        for (const r of aptos) if (r.anuncios.some((a) => a.conta_ref === contaRefDe(conta) || a.conta_ref === `nick:${conta.nickname}`)) bloquear(r.sku, `não foi possível confirmar os pedidos da conta ${conta.nickname}: ${e.message}`)
        continue
      }
      const idsPed = [...new Set(pedidos.map((p) => p.id))]
      const existentes = new Set()
      for (const lote of pedacos(idsPed, 200)) {
        const ex = await q(sb.from('ml_orders').select('ml_order_id').eq('empresa_id', empresaId).in('ml_order_id', lote), 'pedidos importados')
        for (const x of (ex || [])) existentes.add(String(x.ml_order_id))
      }
      for (const p of pedidos) {
        if (existentes.has(p.id)) continue
        for (const r of aptos) {
          const itens = p.itens.filter((it) => afeta(r, it))
          if (itens.length) {
            const un = itens.reduce((t, it) => t + (it.qtd || 1), 0)
            r.pedidos.push({ verificacao: 'A', canal: 'mercadolivre', conta: conta.nickname, pedido: p.id, status: p.status, unidades: un, criado: p.criado })
            bloquear(r.sku, `pedido ML ${p.id} (${p.status}, ${un} un., conta ${conta.nickname}) ainda não importado no TMP10`)
          }
        }
      }
    }

    // B) pedidos importados (30 dias): sem baixa, ou registrados com outro SKU no mesmo anúncio · e vendas na Shopee
    const pedidosTmp = await lerTodos(() => sb.from('ml_orders').select('ml_order_id, platform, items, is_fulfillment, status, account_nickname, created_at_ml').eq('empresa_id', empresaId).gte('created_at_ml', desde.toISOString()), 'pedidos recentes')
    const primeira = await q(sb.from('estoque_movimentos').select('criado_em').eq('empresa_id', empresaId).in('origem', ['venda_mercadolivre', 'venda_shopee']).order('criado_em', { ascending: true }).limit(1), 'primeira venda')
    const corte = primeira && primeira[0] ? new Date(primeira[0].criado_em) : null
    const precisa = []   // { r, pedido, sku, plat }
    for (const o of pedidosTmp) {
      if (o.is_fulfillment === true || o.status === 'cancelado') continue
      const itens = Array.isArray(o.items) ? o.items : []
      const plat = o.platform === 'shopee' ? 'shopee' : 'mercadolivre'
      for (const r of aptos) {
        for (const it of itens) {
          const itSku = it && it.sku ? String(it.sku).trim() : null
          const itAnuncio = it && it.ml_item_id !== undefined && it.ml_item_id !== null ? String(it.ml_item_id) : null
          if (plat === 'shopee' && itSku === r.sku) {
            r.pedidos.push({ verificacao: 'B', canal: 'shopee', pedido: o.ml_order_id, sku: itSku })
            bloquear(r.sku, `SKU vendido na Shopee (pedido ${o.ml_order_id}) — nesta versão o ajuste em massa só trata SKUs vendidos apenas no Mercado Livre`)
          } else if (plat === 'mercadolivre' && itAnuncio && anunciosDe.get(r.sku).has(itAnuncio) && itSku && itSku !== r.sku) {
            r.pedidos.push({ verificacao: 'B', canal: 'mercadolivre', pedido: o.ml_order_id, sku: itSku })
            bloquear(r.sku, `venda do anúncio ${itAnuncio} registrada com outro SKU ("${itSku}") — pedido ${o.ml_order_id}: vínculo ou cadastro inconsistente`)
          } else if (plat === 'mercadolivre' && itSku === r.sku && (!corte || new Date(o.created_at_ml) >= corte)) {
            precisa.push({ r, pedido: String(o.ml_order_id), ref: `venda:mercadolivre:${o.ml_order_id}:${r.sku}` })
          }
        }
      }
    }
    const refs2 = [...new Set(precisa.map((x) => x.ref))]
    const movs = new Map()
    for (const lote of pedacos(refs2, 200)) {
      const ms = await q(sb.from('estoque_movimentos').select('referencia, aplicado, observacao').eq('empresa_id', empresaId).in('referencia', lote), 'movimentos de venda')
      for (const m of (ms || [])) movs.set(m.referencia, m)
    }
    for (const x of precisa) {
      const m = movs.get(x.ref)
      if (!m) { x.r.pedidos.push({ verificacao: 'B', pedido: x.pedido, sem_baixa: true }); bloquear(x.r.sku, `pedido ML ${x.pedido} importado mas SEM baixa registrada no TMP10`) }
      else if (!m.aplicado) x.r.avisos.push(`pedido ${x.pedido}: venda registrada sem baixa (${m.observacao || 'não aplicada'})`)
    }

    // C) cancelamento no ML ainda não processado no TMP10 (GET /orders/{id}, mesmo endpoint do webhook)
    for (const r of aptos) {
      if (r.situacao !== 'apto') continue
      const abertos = pedidosTmp.filter((o) => o.platform !== 'shopee' && o.is_fulfillment !== true && !['cancelado', 'finalizado', 'full_ml'].includes(o.status)
        && (Array.isArray(o.items) ? o.items : []).some((it) => (it && String(it.sku || '').trim() === r.sku) || (it && it.ml_item_id && anunciosDe.get(r.sku).has(String(it.ml_item_id)))))
      if (abertos.length > MAX_PEDIDOS_CANCELAMENTO_POR_SKU) { bloquear(r.sku, `${abertos.length} pedidos recentes em aberto para conferir cancelamento (máximo ${MAX_PEDIDOS_CANCELAMENTO_POR_SKU}) — revisão manual`); continue }
      for (const o of abertos) {
        const conta = contas.find((c) => c.nickname === o.account_nickname)
        if (!conta) { bloquear(r.sku, `conta ${o.account_nickname || '?'} do pedido ${o.ml_order_id} não conectada — não dá para conferir cancelamento`); break }
        let st
        try { st = await ml.lerPedido(conta, o.ml_order_id) } catch (e) { bloquear(r.sku, `não foi possível conferir o pedido ${o.ml_order_id}: ${e.message}`); break }
        if (STATUS_ML_CANCELADO.includes(st.status)) {
          r.pedidos.push({ verificacao: 'C', canal: 'mercadolivre', pedido: o.ml_order_id, status: st.status })
          bloquear(r.sku, `pedido ML ${o.ml_order_id} está "${st.status}" no ML e ainda aberto no TMP10 (cancelamento não processado)`)
          break
        }
        await dormir()
      }
    }
    for (const r of aptos) if (r.situacao === 'apto') r.pedidos_conferidos_em = agora().toISOString()
  }

  // Anúncios que receberiam o novo número pela fila (todos os vínculos do SKU), com a decisão de AGORA
  async function previaFila(empresaId, r, cfg) {
    const d = decidirEnvio(cfg, r.sku)
    return r.anuncios.map((a) => ({ canal: 'mercadolivre', conta: a.conta, anuncio_id: a.anuncio_id, atual: a.quantidade, novo: r.novo,
      envio: a.full ? 'bloqueado (Full)' : (d.real ? 'real' : 'simulado'), motivo: a.full ? 'Full: estoque fica com o ML' : d.motivo }))
  }

  async function registrarEventos(linhas) {
    for (const lote of pedacos(linhas, 200)) await q(sb.from('estoque_ajuste_massa_eventos').insert(lote), 'auditoria do ajuste em massa')
  }
  const resumoDe = (itens) => ({ analisados: itens.length, aptos: itens.filter((i) => i.situacao === 'apto').length,
    iguais: itens.filter((i) => i.situacao === 'igual').length, bloqueados: itens.filter((i) => i.situacao === 'bloqueado').length })

  // ── SIMULAÇÃO ───────────────────────────────────────────────────────────────────────────────────────────────────────
  async function validarEntrada(empresaId, contaRef, skus) {
    const lista = [...new Set((Array.isArray(skus) ? skus : []).map((s) => String(s).trim()).filter(Boolean))]
    if (!lista.length) throw erroHttp('Selecione ao menos um SKU.', 400)
    if (lista.length > LIMITE_SKUS) throw erroHttp(`No máximo ${LIMITE_SKUS} SKUs por vez.`, 400)
    const conta = (await contasML(empresaId)).find((c) => contaRefDe(c) === String(contaRef || ''))
    if (!conta) throw erroHttp('Conta do Mercado Livre de origem não encontrada nesta empresa.', 400)
    return { lista, conta }
  }

  async function simular({ empresaId, usuarioId, contaRef, skus, id = crypto.randomUUID() }) {
    const { lista, conta } = await validarEntrada(empresaId, contaRef, skus)
    const job = { tipo: 'simulacao', fase: 'lendo anúncios', processados: 0, total: lista.length, iniciado_em: agora().toISOString(), empresa_id: empresaId }
    jobs.set(id, job)
    try {
      const res = await avaliar(empresaId, lista, conta)
      const cfg = await lerConfig(empresaId)
      const itens = []
      for (const sku of lista) {
        const r = res.get(sku)
        itens.push({ sku, nome: r.nome || null, produto_id: r.produto_id || null, situacao: r.situacao, motivo: r.motivo, tmp10_antes: r.tmp10 ?? null,
          numero_lido: r.numero_lido ?? null, novo: r.situacao === 'apto' ? r.novo : null, anuncio_origem: r.anuncio_origem || null,
          anuncios: r.anuncios, pedidos: r.pedidos, avisos: [...new Set(r.avisos)], pedidos_conferidos_em: r.pedidos_conferidos_em || null,
          fila: r.situacao === 'apto' ? await previaFila(empresaId, r, cfg) : [] })
      }
      const resumo = { ...resumoDe(itens), modo: cfg.modo, aviso: AVISO_FIXO, limite_quantidade: limiteQuantidade }
      const expira = new Date(agora().getTime() + VALIDADE_MINUTOS * 60000)
      await q(sb.from('estoque_ajuste_massa_execucoes').insert({ id, empresa_id: empresaId, usuario_id: usuarioId || null, plataforma: 'mercadolivre',
        conta_ref: contaRefDe(conta), conta_nome: conta.nickname, limite_quantidade: limiteQuantidade, itens, resumo, expira_em: expira.toISOString() }), 'registrar simulação')
      await registrarEventos(itens.map((i) => ({ execucao_id: id, empresa_id: empresaId, usuario_id: usuarioId || null, modo: 'simulacao', tentativa: 1, sku: i.sku,
        produto_id: i.produto_id, plataforma: 'mercadolivre', conta_ref: contaRefDe(conta), anuncio_id: i.anuncio_origem, numero_lido: i.numero_lido,
        estoque_anterior: i.tmp10_antes, estoque_novo: i.novo, resultado: i.situacao === 'apto' ? 'simulado' : i.situacao === 'igual' ? 'igual' : 'bloqueado',
        motivo: i.motivo, detalhe: { anuncios: i.anuncios, pedidos: i.pedidos, avisos: i.avisos, pedidos_conferidos_em: i.pedidos_conferidos_em } })))
      Object.assign(job, { fase: 'concluida', processados: lista.length, terminado_em: agora().toISOString() })
      log(`📋 [ESTOQUE] ajuste em massa: simulação ${id} — ${JSON.stringify(resumo)}`)
      return { execucao_id: id, resumo, itens, expira_em: expira.toISOString() }
    } catch (e) {
      Object.assign(job, { fase: 'erro', erro: e.message, terminado_em: agora().toISOString() })
      throw e
    }
  }
  function iniciarSimulacao(args) {   // para a rota: valida já, roda em segundo plano
    const id = crypto.randomUUID()
    return validarEntrada(args.empresaId, args.contaRef, args.skus).then(() => {
      simular({ ...args, id }).catch((e) => log(`❌ [ESTOQUE] ajuste em massa: simulação ${id}: ${e.message}`))
      return { execucao_id: id }
    })
  }

  // ── EXECUÇÃO / RETOMADA ─────────────────────────────────────────────────────────────────────────────────────────────
  async function carregarExecucao(empresaId, id) {
    if (!ehUuid(id)) throw erroHttp('Informe a simulação (execucao_id).', 400)
    const ex = await q(sb.from('estoque_ajuste_massa_execucoes').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle(), 'simulação')
    if (!ex) throw erroHttp('Simulação não encontrada.', 404)
    return ex
  }
  const referenciaDe = (id, sku) => `massa:${id}:${sku}`
  async function movimentosDaExecucao(empresaId, id, skus) {
    const m = new Map()
    for (const lote of pedacos(skus.map((s) => referenciaDe(id, s)), 200)) {
      const ms = await q(sb.from('estoque_movimentos').select('id, referencia, aplicado, estoque_anterior, estoque_novo, criado_em').eq('empresa_id', empresaId).in('referencia', lote), 'movimentos da execução')
      for (const x of (ms || [])) m.set(x.referencia, x)
    }
    return m
  }

  // valida e TRAVA (no banco) antes de qualquer alteração; erro aqui não altera nada
  async function preparar({ empresaId, execucaoId }) {
    const ex = await carregarExecucao(empresaId, execucaoId)
    if (new Date(ex.expira_em) < agora()) throw erroHttp('A simulação venceu (60 minutos). Simule de novo.', 409)
    if (executandoEmpresa.has(empresaId)) throw erroHttp('Já existe um ajuste em massa em andamento nesta empresa.', 409)
    if (!(await rpc('estoque_ajuste_massa_travar', { p_empresa: empresaId, p_execucao: ex.id, p_dono: dono, p_segundos: TRAVA_SEGUNDOS }))) throw erroHttp('Já existe um ajuste em massa em andamento nesta empresa.', 409)
    executandoEmpresa.add(empresaId)
    return ex
  }
  async function executar(args) { return rodar(await preparar(args), args) }
  async function iniciarExecucao(args) {   // para a rota: valida e trava já; executa em segundo plano
    const ex = await preparar(args)
    rodar(ex, args).catch((e) => log(`❌ [ESTOQUE] ajuste em massa ${ex.id}: ${e.message}`))
    return { execucao_id: ex.id }
  }

  async function rodar(ex, { empresaId, usuarioId }) {
    const aptos = (ex.itens || []).filter((i) => i.situacao === 'apto')
    const job = { tipo: 'execucao', fase: 'executando', processados: 0, total: aptos.length, iniciado_em: agora().toISOString(), empresa_id: empresaId }
    jobs.set(ex.id, job)
    const contaOrigem = (await contasML(empresaId)).find((c) => contaRefDe(c) === ex.conta_ref)
    const resultado = []
    try {
      const anteriores = await q(sb.from('estoque_ajuste_massa_eventos').select('sku, resultado, tentativa').eq('execucao_id', ex.id).eq('modo', 'execucao'), 'eventos anteriores')
      const tentativa = 1 + Math.max(0, ...((anteriores || []).map((e) => e.tentativa)))
      const jaEvento = new Set((anteriores || []).filter((e) => ['aplicado', 'ja_aplicado'].includes(e.resultado)).map((e) => e.sku))
      const movs = await movimentosDaExecucao(empresaId, ex.id, aptos.map((i) => i.sku))
      const evento = (i, resultadoItem, motivo, extra = {}) => ({ execucao_id: ex.id, empresa_id: empresaId, usuario_id: usuarioId || null, modo: 'execucao', tentativa,
        sku: i.sku, produto_id: i.produto_id, plataforma: 'mercadolivre', conta_ref: ex.conta_ref, anuncio_id: i.anuncio_origem, numero_lido: extra.numero_lido ?? null,
        estoque_anterior: extra.anterior ?? i.tmp10_antes, estoque_novo: extra.novo ?? i.novo, resultado: resultadoItem, motivo, detalhe: extra.detalhe || null, movimento_id: extra.movimento_id || null })
      // já aplicados (movimento existe): não reaplica; se faltou o evento (interrupção), registra ja_aplicado
      const pendentes = []
      for (const i of aptos) {
        const m = movs.get(referenciaDe(ex.id, i.sku))
        if (m && m.aplicado) {
          if (!jaEvento.has(i.sku)) { const ev = evento(i, 'ja_aplicado', 'movimento já existia (retomada após interrupção)', { movimento_id: m.id, anterior: m.estoque_anterior, novo: m.estoque_novo }); await registrarEventos([ev]); resultado.push(ev) }
          job.processados++
        } else pendentes.push(i)
      }
      if (!contaOrigem) {
        const evs = pendentes.map((i) => evento(i, 'bloqueado', 'conta de origem não está mais conectada nesta empresa'))
        await registrarEventos(evs); resultado.push(...evs); job.processados += pendentes.length
      } else {
        for (const lote of pedacos(pendentes, 20)) {
          let aval
          try { aval = await avaliar(empresaId, lote.map((i) => i.sku), contaOrigem) } catch (e) {
            const evs = lote.map((i) => evento(i, 'falha', `falha ao revalidar: ${e.message}`)); await registrarEventos(evs); resultado.push(...evs); job.processados += lote.length; continue
          }
          for (const i of lote) {
            const r = aval.get(i.sku)
            let ev
            try {
              if (r.situacao !== 'apto') ev = evento(i, r.situacao === 'igual' ? 'igual' : 'bloqueado', `revalidação: ${r.motivo}`, { numero_lido: r.numero_lido ?? null, detalhe: { anuncios: r.anuncios, pedidos: r.pedidos } })
              else if (r.numero_lido !== i.novo) ev = evento(i, 'bloqueado', `o número do anúncio mudou de ${i.novo} para ${r.numero_lido} desde a simulação — simule de novo`, { numero_lido: r.numero_lido })
              else {
                const mov = await movimentar({ empresaId, sku: i.sku, tipo: 'definir', quantidade: i.novo, origem: 'ajuste_massa',
                  motivo: `Ajuste em massa: número do Mercado Livre (conta ${ex.conta_nome}, anúncio ${i.anuncio_origem}) — execução ${ex.id}`,
                  referencia: referenciaDe(ex.id, i.sku), usuarioId, processo: 'erp', esperado: i.tmp10_antes })
                if (mov && mov.aplicado && mov.duplicado) ev = evento(i, 'ja_aplicado', 'movimento já existia', { movimento_id: mov.movimento_id, anterior: mov.anterior, novo: mov.novo, numero_lido: r.numero_lido })
                else if (mov && mov.aplicado) {
                  ev = evento(i, 'aplicado', null, { movimento_id: mov.movimento_id, anterior: mov.anterior, novo: mov.novo, numero_lido: r.numero_lido })
                  try {   // o anúncio agora mostra o mesmo número do TMP10: as divergências abertas dos anúncios do SKU se resolvem
                    await q(sb.from('estoque_divergencias').update({ resolvido: true, resolucao: 'ajuste_massa', resolvido_em: agora().toISOString(), resolvido_por: usuarioId || null })
                      .eq('empresa_id', empresaId).eq('sku', i.sku).eq('plataforma', 'mercadolivre').not('chave', 'is', null).not('resolvido', 'is', true), 'resolver divergências')
                  } catch (e) { log(`[ESTOQUE] ajuste em massa: não resolveu divergências de ${i.sku}: ${e.message}`) }
                } else if (mov && mov.erro === 'estoque_mudou') ev = evento(i, 'bloqueado', `o estoque do TMP10 mudou para ${mov.anterior} desde a simulação — simule de novo`, { anterior: mov.anterior, novo: null })
                else ev = evento(i, 'falha', `não aplicado: ${(mov && mov.erro) || 'erro'}`)
              }
            } catch (e) { ev = evento(i, 'falha', e.message) }
            await registrarEventos([ev]); resultado.push(ev); job.processados++
          }
          if (!(await rpc('estoque_ajuste_massa_renovar', { p_empresa: empresaId, p_execucao: ex.id, p_dono: dono, p_segundos: TRAVA_SEGUNDOS }))) {
            log(`⚠️ [ESTOQUE] ajuste em massa ${ex.id}: trava perdida — interrompido; use "Retomar pendentes"`); job.erro = 'trava perdida — retome os pendentes'; break
          }
        }
      }
      job.fase = 'concluida'
      log(`✅ [ESTOQUE] ajuste em massa ${ex.id}: ${resultado.length} item(ns) processados`)
      return { execucao_id: ex.id, tentativa, resultados: resultado }
    } catch (e) {
      Object.assign(job, { fase: 'erro', erro: e.message })
      throw e
    } finally {
      job.terminado_em = agora().toISOString()
      executandoEmpresa.delete(empresaId)
      try { await rpc('estoque_ajuste_massa_liberar', { p_empresa: empresaId, p_execucao: ex.id, p_dono: dono }) } catch (e) { log(`[ESTOQUE] ajuste em massa: trava não liberada (${e.message}) — expira em ${TRAVA_SEGUNDOS}s`) }
    }
  }
  // ── Situação de uma simulação/execução: aplicado (movimento existe) / bloqueado / falha / pendente ──────────────────────
  async function status(empresaId, id) {
    if (!ehUuid(id)) throw erroHttp('Informe a simulação.', 400)
    const job = jobs.get(id)
    const ex = await q(sb.from('estoque_ajuste_massa_execucoes').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle(), 'simulação')
    if (!ex) {
      if (job && job.empresa_id === empresaId) return { execucao_id: id, andamento: { ...job, empresa_id: undefined } }
      throw erroHttp('Simulação não encontrada.', 404)
    }
    const eventos = await q(sb.from('estoque_ajuste_massa_eventos').select('sku, modo, tentativa, resultado, motivo, numero_lido, estoque_anterior, estoque_novo, movimento_id, criado_em').eq('execucao_id', id).order('id', { ascending: true }), 'eventos')
    const movs = await movimentosDaExecucao(empresaId, id, (ex.itens || []).map((i) => i.sku))
    const itens = (ex.itens || []).map((i) => {
      const evs = (eventos || []).filter((e) => e.sku === i.sku && e.modo === 'execucao')
      const ult = evs[evs.length - 1]
      const m = movs.get(referenciaDe(id, i.sku))
      const execucao = i.situacao !== 'apto' ? null
        : m && m.aplicado ? { situacao: 'aplicado', anterior: m.estoque_anterior, novo: m.estoque_novo, em: m.criado_em }
        : ult && ult.resultado === 'bloqueado' ? { situacao: 'bloqueado', motivo: ult.motivo }
        : ult && ult.resultado === 'igual' ? { situacao: 'igual', motivo: ult.motivo }
        : ult && ult.resultado === 'falha' ? { situacao: 'pendente', motivo: `falhou: ${ult.motivo}` }
        : { situacao: 'pendente', motivo: null }
      return { ...i, execucao }
    })
    const exec = itens.filter((i) => i.execucao)
    return { execucao_id: id, conta_ref: ex.conta_ref, conta_nome: ex.conta_nome, criado_em: ex.criado_em, expira_em: ex.expira_em, vencida: new Date(ex.expira_em) < agora(),
      resumo: ex.resumo, itens, andamento: job ? { ...job, empresa_id: undefined } : null,
      execucao_resumo: { aplicados: exec.filter((i) => i.execucao.situacao === 'aplicado').length, bloqueados: exec.filter((i) => i.execucao.situacao === 'bloqueado').length,
        iguais: exec.filter((i) => i.execucao.situacao === 'igual').length, pendentes: exec.filter((i) => i.execucao.situacao === 'pendente').length } }
  }

  // ── Lista para a tela (só banco; NÃO é usada para decidir nada) ────────────────────────────────────────────────────────
  async function itens({ empresaId, contaRef }) {
    const contas = await contasML(empresaId)
    const resposta = { contas: contas.map((c) => ({ conta_ref: contaRefDe(c), nome: c.nickname })), itens: [], limite_skus: LIMITE_SKUS, limite_quantidade: limiteQuantidade }
    // vendas sem baixa (30 dias): anúncios que vendem sem produto no TMP10 — resolver vínculos ANTES de importar números
    const desde = new Date(agora().getTime() - JANELA_DIAS * 86400000).toISOString()
    const semBaixa = await q(sb.from('estoque_movimentos').select('sku, referencia, criado_em').eq('empresa_id', empresaId).in('origem', ['venda_mercadolivre', 'venda_shopee'])
      .eq('aplicado', false).gte('criado_em', desde).order('criado_em', { ascending: false }).limit(500), 'vendas sem baixa')
    const porSku = new Map()
    for (const m of (semBaixa || [])) { const x = porSku.get(m.sku) || { sku: m.sku, pedidos: 0, ultima: m.criado_em, canal: String(m.referencia || '').split(':')[1] || null }; x.pedidos++; porSku.set(m.sku, x) }
    resposta.vendas_sem_baixa = [...porSku.values()]
    const conta = contas.find((c) => contaRefDe(c) === String(contaRef || ''))
    if (!conta) return resposta
    const links = await lerTodos(() => sb.from('product_ml_links').select('sku, ml_item_id, ml_user_id, account_nickname, quantity').eq('empresa_id', empresaId), 'vínculos ML')
    const daConta = links.filter((l) => l.ml_item_id && contaDoLink([conta], l))
    const skus = [...new Set(daConta.map((l) => l.sku))]
    const prods = new Map()
    for (const lote of pedacos(skus, 300)) for (const p of (await q(sb.from('products').select('sku, name, estoque_atual').eq('empresa_id', empresaId).in('sku', lote), 'produtos')) || []) prods.set(p.sku, p)
    const div = await lerTodos(() => sb.from('estoque_divergencias').select('sku, anuncio_id, estoque_ml, atualizado_em').eq('empresa_id', empresaId).eq('plataforma', 'mercadolivre').not('chave', 'is', null).not('resolvido', 'is', true), 'divergências')
    resposta.itens = skus.sort().map((sku) => {
      const p = prods.get(sku)
      const anuncios = links.filter((l) => l.sku === sku && l.ml_item_id).map((l) => {
        const d = div.find((x) => x.sku === sku && x.anuncio_id === String(l.ml_item_id))
        return { anuncio_id: String(l.ml_item_id), conta: l.account_nickname, ultima_leitura: d ? d.estoque_ml : null, lida_em: d ? d.atualizado_em : null }
      })
      return { sku, nome: p ? p.name : null, tmp10: p ? p.estoque_atual : null, anuncios, com_divergencia: anuncios.some((a) => a.ultima_leitura !== null) }
    })
    return resposta
  }

  // ── DIAGNÓSTICO ML (SÓ LEITURA): quantidade atual de cada anúncio vinculado aos SKUs ─────────────────────────────────
  async function diagnosticoML({ empresaId, skus }) {
    const lista = [...new Set((Array.isArray(skus) ? skus : String(skus || '').split(',')).map((s) => String(s).trim()).filter(Boolean))]
    if (!lista.length) throw erroHttp('Informe ao menos um SKU.', 400)
    if (lista.length > 10) throw erroHttp('No máximo 10 SKUs por consulta.', 400)
    const contas = await contasML(empresaId)
    const saida = []
    for (const sku of lista) {
      const prods = (await q(sb.from('products').select('sku, estoque_atual').eq('empresa_id', empresaId).ilike('sku', sku.replace(/[%_\\]/g, '\\$&')), 'produtos')) || []
      const links = (await q(sb.from('product_ml_links').select('sku, account_nickname, ml_item_id, ml_user_id, quantity, updated_at, ml_variation_id').eq('empresa_id', empresaId).ilike('sku', sku.replace(/[%_\\]/g, '\\$&')), 'vínculos')) || []
      const div = (await q(sb.from('estoque_divergencias').select('anuncio_id, sku, estoque_ml, atualizado_em').eq('empresa_id', empresaId).eq('plataforma', 'mercadolivre').not('chave', 'is', null).ilike('sku', sku.replace(/[%_\\]/g, '\\$&')), 'divergências')) || []
      const exato = prods.find((p) => p.sku === sku)
      const item = { sku_pedido: sku, produto: exato ? { sku: exato.sku, estoque_tmp10: exato.estoque_atual } : null,
        outras_grafias: { produtos: prods.filter((p) => p.sku !== sku).map((p) => ({ sku: p.sku, estoque_tmp10: p.estoque_atual })), vinculos: [...new Set(links.filter((l) => l.sku !== sku).map((l) => l.sku))] },
        anuncios: [] }
      const porConta = new Map()
      for (const l of links) {
        const c = contaDoLink(contas, l)
        const a = { sku_vinculo: l.sku, conta: l.account_nickname, ml_item_id: String(l.ml_item_id), variacao: l.ml_variation_id || null,
          quantidade_gravada_no_vinculo: l.quantity ?? null, gravada_em: l.updated_at || null }
        const d = div.find((x) => x.anuncio_id === a.ml_item_id && x.sku === l.sku)
        a.ultima_divergencia = d ? { estoque_ml: d.estoque_ml, em: d.atualizado_em } : null
        item.anuncios.push(a)
        if (!c) { a.erro = 'conta não conectada/ativa nesta empresa'; continue }
        if (!porConta.has(c.id)) porConta.set(c.id, { conta: c, lista: [] })
        porConta.get(c.id).lista.push(a)
      }
      for (const { conta, lista: as } of porConta.values()) {
        for (const lote of pedacos(as, 20)) {
          let mapa = null, erro = null
          try { mapa = await ml.lerAnuncios(conta, [...new Set(lote.map((a) => a.ml_item_id))]) } catch (e) { erro = e.message }
          const em = agora().toISOString()
          for (const a of lote) {
            const l = mapa ? mapa.get(a.ml_item_id) : null
            Object.assign(a, { consultado_em: em, quantidade_api: l && !l.erro ? l.quantidade : null, titulo: l && !l.erro ? l.titulo : null,
              sku_declarado_no_anuncio: l && !l.erro ? l.sku_declarado : null, variacoes_no_anuncio: l && !l.erro ? l.variacoes : null,
              erro: erro || (l && l.erro) || (l ? null : 'anúncio não devolvido pelo ML') })
          }
        }
      }
      saida.push(item)
    }
    return { consultado_em: agora().toISOString(), skus: saida, observacao: 'Somente leitura. Nenhuma quantidade foi somada, gravada ou enviada.' }
  }

  return { simular, iniciarSimulacao, executar, iniciarExecucao, status, itens, diagnosticoML, avaliar }
}

module.exports = { criarAjusteMassa, LIMITE_SKUS, LIMITE_QUANTIDADE_PADRAO, AVISO_FIXO }
