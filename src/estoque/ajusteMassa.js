// Estoque Central — AJUSTE EM MASSA (Marketplaces → TMP10): Mercado Livre e Shopee, uma ou várias contas/lojas.
//
// O usuário escolhe contas do ML e/ou lojas da Shopee e os SKUs (sem limite de quantidade). A SIMULAÇÃO roda em segundo
// plano, em LOTES internos, lê AO VIVO todos os anúncios vinculados a cada SKU (nas duas plataformas, em todas as contas),
// confere vínculos e pedidos e grava UM evento de auditoria por SKU. A EXECUÇÃO só aceita uma simulação concluída e válida,
// revalida tudo em lotes e grava pelo caminho oficial (estoque_movimentar), com referência idempotente massa:{execução}:{sku}.
// Os anúncios do SKU entram na fila que já existe (PILOTO/ATIVO/DESLIGADO + reserva da Shopee). Nunca envia nada daqui.
//
// O SKU é BLOQUEADO (sozinho; os outros seguem) quando:
//   • cadastro: produto inexistente, duplicado ou sem estoque oficial
//   • vínculos: sem anúncio nas contas/lojas selecionadas · conta/loja de algum vínculo não conectada · vínculo ML com variação
//     · "não sincronizar" · anúncio ML ligado a mais de um SKU · item/variação Shopee ligado a mais de um SKU · SKU ligado a
//     duas variações do mesmo item Shopee · vínculo Shopee sem model_id em item que tem variações
//   • leitura: falha · anúncio ML com variações · SKU declarado no anúncio diferente do vínculo · Shopee com reserva de
//     promoção, estoque do vendedor ≠ disponível, estoque no armazém da Shopee ou sem "estoque do vendedor"
//   • números: anúncios discordam (entre anúncios, contas, lojas ou plataformas) · origem só Full/FBS · acima do limite provisório
//   • pedidos: (A) pedido ML paid/payment_in_process/confirmed ou pedido Shopee (qualquer status) ainda não importado
//     (B) venda importada sem baixa ou registrada com outro SKU no mesmo anúncio (C) pedido cancelado/invalidado no ML ou
//     cancelado na Shopee ainda aberto no TMP10 (D) falha ao consultar pedidos.
const crypto = require('crypto')

const LIMITE_QUANTIDADE_PADRAO = 999
const LOTE_SIMULACAO = 50          // SKUs por lote interno (não é limite para o usuário)
const LOTE_EXECUCAO = 20
const VALIDADE_MINUTOS = 60        // depois que a simulação TERMINA
const VALIDADE_MAXIMA_HORAS = 24   // teto absoluto (gravado no cabeçalho, que é imutável)
const JANELA_DIAS = 30
const STATUS_PEDIDOS_ML = ['paid', 'payment_in_process', 'confirmed']   // confirmed: doc oficial do ML (desconta estoque)
const STATUS_ML_CANCELADO = ['cancelled', 'invalid']                      // valores oficiais do ML
const TRAVA_SEGUNDOS = 120
const MARGEM_PEDIDOS_MS = 10 * 60000 // ao reconsultar pedidos, volta 10 min (atraso de indexação)
const AVISO_FIXO = 'Pedidos do ML em payment_required/partially_paid não são verificados: a documentação oficial não confirma se descontam o estoque.'
const ehUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''))
const erroHttp = (msg, status) => Object.assign(new Error(msg), { status })
const ROTULO_PLAT = { mercadolivre: 'ML', shopee: 'Shopee' }

function criarAjusteMassa({ sb, ml, shopee, grupos, q, rpc, movimentar, lerConfig, decidirEnvio, log = console.log, limiteQuantidade = LIMITE_QUANTIDADE_PADRAO,
  agora = () => new Date(), dormir = () => Promise.resolve(), statusCanceladoShopee = () => (process.env.SHOPEE_STATUS_CANCELADO || 'CANCELLED').split(',').map((x) => x.trim()).filter(Boolean) }) {
  const dono = `tmp10-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  const jobs = new Map()            // execucao_id → andamento (memória; o banco é a fonte da verdade)
  const executandoEmpresa = new Set()
  const simulandoEmpresa = new Set()

  async function lerTodos(montar, contexto) {
    const todos = []
    for (let de = 0; ; de += 1000) {
      const lote = await q(montar().range(de, de + 999), contexto)
      todos.push(...(lote || []))
      if (!lote || lote.length < 1000) return todos
    }
  }
  const pedacos = (lista, n) => { const r = []; for (let i = 0; i < lista.length; i += n) r.push(lista.slice(i, i + n)); return r }
  const refDe = (c) => (c.platform === 'shopee' ? 'sh:' : 'ml:') + String(c.ml_user_id)
  async function todasContas(empresaId) {
    const contas = await q(sb.from('ml_accounts').select('id, nickname, ml_user_id, platform, active, empresa_id, access_token, refresh_token, expires_at').eq('empresa_id', empresaId), 'contas')
    return (contas || []).filter((c) => c.active === true)
  }
  async function contasML(empresaId) { return (await todasContas(empresaId)).filter((c) => c.platform !== 'shopee') }
  const contaDoLink = (contas, l) => {
    const achadas = contas.filter((c) => c.platform !== 'shopee' && (l.ml_user_id ? String(c.ml_user_id) === String(l.ml_user_id) : c.nickname === l.account_nickname))
    return achadas.length === 1 ? achadas[0] : null
  }
  const lojaDoLink = (contas, l) => { const a = contas.filter((c) => c.platform === 'shopee' && String(c.ml_user_id) === String(l.shop_id)); return a.length === 1 ? a[0] : null }
  // aceita ['ml:111','sh:555'], 'ml:111,sh:555' e o formato antigo (só o número = conta do ML)
  const refsDe = (contaRef, contasRef) => [...new Set((Array.isArray(contasRef) ? contasRef : String(contasRef || contaRef || '').split(','))
    .map((x) => String(x).trim()).filter(Boolean).map((x) => (/^(ml|sh):/.test(x) ? x : 'ml:' + x)))]
  async function anunciosFull(empresaId, ids) {
    try {
      const r = await rpc('estoque_anuncios_full', { p_empresa: empresaId, p_dias: 90 })
      return new Set((r || []).map((x) => String(typeof x === 'object' && x !== null ? Object.values(x)[0] : x)))
    } catch (e) {
      const s = new Set()
      for (const id of ids) if (await rpc('estoque_anuncio_tem_full', { p_empresa: empresaId, p_anuncio: id, p_dias: 90 })) s.add(id)
      return s
    }
  }
  const somaEstoque = (lista) => (Array.isArray(lista) ? lista.reduce((t, x) => t + (Number(x && x.stock) || 0), 0) : null)

  // ── Contexto de pedidos de UMA corrida (simulação ou execução): consultado DEPOIS da leitura de cada lote, ──────────
  // incremental (só o que é novo desde a última consulta, com margem). O que mudar o estoque do TMP10 entre a foto e a
  // gravação é barrado pelo "estoque esperado" do estoque_movimentar.
  function novoContexto(empresaId) {
    return { empresaId, ml: new Map(), sh: new Map(), importados: new Set(), naoImportados: new Map(), statusSh: new Map(), erroConta: new Map(),
      pedidosTmp: null, pedidosTmpEm: 0, corte: undefined, grupos: null }
  }
  async function atualizarPedidos(ctx, contas) {
    const desdeJanela = new Date(agora().getTime() - JANELA_DIAS * 86400000)
    for (const conta of contas) {
      const ref = refDe(conta)
      if (ctx.erroConta.has(ref)) continue
      try {
        if (conta.platform !== 'shopee') {
          const st = ctx.ml.get(ref) || { pedidos: new Map(), cancelados: new Set(), ultimo: null }
          const desde = st.ultimo ? new Date(st.ultimo - MARGEM_PEDIDOS_MS) : desdeJanela
          const inicio = agora().getTime()
          for (const s of STATUS_PEDIDOS_ML) for (const p of await ml.buscarPedidos(conta, s, desde)) st.pedidos.set(p.id, p)
          for (const s of STATUS_ML_CANCELADO) for (const p of await ml.buscarPedidos(conta, s, desde)) { st.cancelados.add(p.id); st.pedidos.delete(p.id) }
          st.ultimo = inicio; ctx.ml.set(ref, st)
        } else {
          const st = ctx.sh.get(ref) || { sns: new Set(), ultimo: null }
          const desde = st.ultimo ? new Date(st.ultimo - MARGEM_PEDIDOS_MS) : desdeJanela
          const inicio = agora().getTime()
          for (const sn of await shopee.buscarPedidos(conta, desde, inicio)) st.sns.add(sn)
          st.ultimo = inicio; ctx.sh.set(ref, st)
        }
      } catch (e) { ctx.erroConta.set(ref, `não foi possível confirmar os pedidos de ${conta.nickname}: ${e.message}`) }
      await dormir()
    }
    // quais pedidos ainda não estão no TMP10 (reconsulta os que faltavam)
    const ids = []
    for (const st of ctx.ml.values()) for (const id of st.pedidos.keys()) if (!ctx.importados.has(id)) ids.push(id)
    for (const st of ctx.sh.values()) for (const sn of st.sns) if (!ctx.importados.has(sn)) ids.push(sn)
    for (const lote of pedacos([...new Set(ids)], 200)) {
      const ex = await q(sb.from('ml_orders').select('ml_order_id').eq('empresa_id', ctx.empresaId).in('ml_order_id', lote), 'pedidos importados')
      for (const x of (ex || [])) { ctx.importados.add(String(x.ml_order_id)); ctx.naoImportados.delete(String(x.ml_order_id)) }
    }
    // pedidos Shopee que faltam: detalhe (itens/status) para saber quais SKUs afetam
    for (const conta of contas.filter((c) => c.platform === 'shopee')) {
      const st = ctx.sh.get(refDe(conta)); if (!st) continue
      const faltam = [...st.sns].filter((sn) => !ctx.importados.has(sn) && !ctx.naoImportados.has(sn))
      try {
        for (const lote of pedacos(faltam, 50)) { for (const d of await shopee.detalharPedidos(conta, lote)) { ctx.naoImportados.set(d.sn, { ...d, conta: conta.nickname, plataforma: 'shopee' }); ctx.statusSh.set(d.sn, d.status) } await dormir() }
      } catch (e) { ctx.erroConta.set(refDe(conta), `não foi possível detalhar os pedidos de ${conta.nickname}: ${e.message}`) }
    }
    for (const [ref, st] of ctx.ml) {
      const nome = (contas.find((c) => refDe(c) === ref) || {}).nickname || ref
      for (const p of st.pedidos.values()) if (!ctx.importados.has(p.id)) ctx.naoImportados.set(p.id, { ...p, conta: nome, plataforma: 'mercadolivre' })
    }
    // pedidos do TMP10 (30 dias): foto renovada a cada 2 min (o estoque esperado cobre o resto)
    if (!ctx.pedidosTmp || agora().getTime() - ctx.pedidosTmpEm > 120000) {
      ctx.pedidosTmp = await lerTodos(() => sb.from('ml_orders').select('ml_order_id, platform, items, is_fulfillment, status, account_nickname, created_at_ml')
        .eq('empresa_id', ctx.empresaId).gte('created_at_ml', desdeJanela.toISOString()), 'pedidos recentes')
      ctx.pedidosTmpEm = agora().getTime()
    }
    if (ctx.corte === undefined) {
      const primeira = await q(sb.from('estoque_movimentos').select('criado_em').eq('empresa_id', ctx.empresaId).in('origem', ['venda_mercadolivre', 'venda_shopee']).order('criado_em', { ascending: true }).limit(1), 'primeira venda')
      ctx.corte = primeira && primeira[0] ? new Date(primeira[0].criado_em) : null
    }
  }

  // ── Avaliação de um LOTE de SKUs (simulação e execução) ──────────────────────────────────────────────────────────
  // 1) banco  2) leitura AO VIVO dos anúncios (ML e Shopee)  3) DEPOIS, pedidos (contexto incremental)
  async function avaliar(empresaId, skus, refsOrigem, ctx = novoContexto(empresaId)) {
    const origem = new Set(refsOrigem)
    const res = new Map()
    const bloquear = (sku, motivo) => { const r = res.get(sku); if (r && r.situacao !== 'bloqueado') { r.situacao = 'bloqueado'; r.motivo = motivo } }
    for (const sku of skus) res.set(sku, { sku, situacao: 'pendente', motivo: null, anuncios: [], avisos: [AVISO_FIXO], pedidos: [] })

    const contas = await todasContas(empresaId)
    // agrupamento (migração 26): o produto principal reúne os anúncios agrupados nele; o SKU agrupado em outro fica fora
    const g = ctx.grupos || (ctx.grupos = await grupos.carregar(empresaId))
    const consulta = [...new Set(skus.flatMap((sku) => [...g.originais(sku)]))]
    const prods = await lerTodos(() => sb.from('products').select('id, sku, name, estoque_atual').eq('empresa_id', empresaId).in('sku', skus), 'produtos')
    const linksML = await lerTodos(() => sb.from('product_ml_links').select('sku, account_nickname, ml_item_id, ml_user_id, sincronizar, ml_variation_id').eq('empresa_id', empresaId).in('sku', consulta), 'vínculos ML')
    const linksSh = await lerTodos(() => sb.from('product_shopee_links').select('sku, shop_id, item_id, model_id, sincronizar').eq('empresa_id', empresaId).in('sku', consulta), 'vínculos Shopee')
    const efML = (l) => g.skuEfetivo('mercadolivre', String(l.ml_item_id), '', l.sku)
    const efSh = (l) => g.skuEfetivo('shopee', String(l.item_id), l.model_id ? String(l.model_id) : '', l.sku)
    const idsML = [...new Set(linksML.map((l) => String(l.ml_item_id)).filter(Boolean))]
    const outrosML = idsML.length ? await lerTodos(() => sb.from('product_ml_links').select('sku, ml_item_id').eq('empresa_id', empresaId).in('ml_item_id', idsML), 'vínculos do anúncio ML') : []
    const itensSh = [...new Set(linksSh.map((l) => String(l.item_id)))]
    const outrosSh = itensSh.length ? await lerTodos(() => sb.from('product_shopee_links').select('sku, shop_id, item_id, model_id').eq('empresa_id', empresaId).in('item_id', itensSh), 'vínculos do item Shopee') : []
    const skusDoML = new Map(); for (const o of outrosML) { const k = String(o.ml_item_id); if (!skusDoML.has(k)) skusDoML.set(k, new Set()); skusDoML.get(k).add(o.sku) }
    const full = await anunciosFull(empresaId, [...idsML, ...itensSh])
    const nome = (a) => `${ROTULO_PLAT[a.plataforma]} ${a.conta} ${a.anuncio_id}${a.variacao_id ? '/' + a.variacao_id : ''}`

    for (const sku of skus) {
      const r = res.get(sku)
      const principal = g.principalDe(sku)
      if (principal) { bloquear(sku, `SKU agrupado no produto principal ${principal} — o estoque oficial é o do principal; ajuste pelo ${principal}`); continue }
      r._originais = g.originais(sku); r.agrupados = g.membros(sku).length
      const ps = prods.filter((p) => p.sku === sku)
      if (ps.length !== 1) { bloquear(sku, ps.length ? 'mais de um produto com este SKU no cadastro' : 'produto não cadastrado no TMP10'); continue }
      r.produto_id = ps[0].id; r.nome = ps[0].name; r.tmp10 = ps[0].estoque_atual
      if (r.tmp10 === null || r.tmp10 === undefined) { bloquear(sku, 'produto sem estoque oficial definido no TMP10'); continue }
      for (const l of linksML.filter((x) => x.ml_item_id && efML(x) === sku)) {
        const c = contaDoLink(contas, l)
        r.anuncios.push({ plataforma: 'mercadolivre', conta_ref: c ? refDe(c) : null, conta: c ? c.nickname : l.account_nickname, anuncio_id: String(l.ml_item_id), variacao_id: '', sku_original: l.sku,
          full: full.has(String(l.ml_item_id)), _l: l, _c: c })
      }
      for (const l of linksSh.filter((x) => efSh(x) === sku)) {
        const c = lojaDoLink(contas, l)
        r.anuncios.push({ plataforma: 'shopee', conta_ref: c ? refDe(c) : null, conta: c ? c.nickname : `loja ${l.shop_id}`, anuncio_id: String(l.item_id), variacao_id: l.model_id ? String(l.model_id) : '', sku_original: l.sku,
          full: full.has(String(l.item_id)), _l: l, _c: c })
      }
      if (!r.anuncios.some((a) => a.conta_ref && origem.has(a.conta_ref))) { bloquear(sku, 'sem anúncio vinculado nas contas/lojas selecionadas'); continue }
      const semConta = r.anuncios.find((a) => !a._c); if (semConta) { bloquear(sku, `conta/loja do anúncio ${nome(semConta)} não está conectada/ativa nesta empresa — não dá para conferir`); continue }
      const varML = r.anuncios.find((a) => a.plataforma === 'mercadolivre' && a._l.ml_variation_id); if (varML) { bloquear(sku, `vínculo com variação no anúncio ${nome(varML)} — fora desta versão`); continue }
      const naoSinc = r.anuncios.find((a) => a._l.sincronizar === false); if (naoSinc) { bloquear(sku, `vínculo do anúncio ${nome(naoSinc)} marcado para não sincronizar`); continue }
      const ambML = r.anuncios.find((a) => a.plataforma === 'mercadolivre' && (skusDoML.get(a.anuncio_id) || new Set()).size > 1)
      if (ambML) { bloquear(sku, `anúncio ${nome(ambML)} está ligado a mais de um SKU (${[...skusDoML.get(ambML.anuncio_id)].join(', ')}) — vínculo ambíguo`); continue }
      let ambSh = null
      for (const a of r.anuncios.filter((x) => x.plataforma === 'shopee')) {
        const doItem = outrosSh.filter((o) => String(o.item_id) === a.anuncio_id && String(o.shop_id) === String(a._l.shop_id))
        const mesmo = doItem.filter((o) => String(o.model_id || '') === a.variacao_id)
        if (new Set(mesmo.map((o) => o.sku)).size > 1) { ambSh = `item/variação ${nome(a)} está ligado a mais de um SKU (${[...new Set(mesmo.map((o) => o.sku))].join(', ')}) — vínculo ambíguo`; break }
        if (doItem.filter((o) => o.sku === a.sku_original).length > 1) { ambSh = `o SKU está ligado a mais de uma variação do item Shopee ${a.anuncio_id} — cores/tamanhos misturados`; break }
        if (!a.variacao_id && doItem.some((o) => o.sku !== a.sku_original)) { ambSh = `item Shopee ${a.anuncio_id} vinculado sem variação, mas o mesmo item também está ligado a outro(s) SKU(s) — vínculo ambíguo`; break }
      }
      if (ambSh) { bloquear(sku, ambSh); continue }
    }

    // 2) leitura AO VIVO
    const ativos = [...res.values()].filter((r) => r.situacao === 'pendente')
    const lidoEm = agora().toISOString()
    const porContaML = new Map(), itensSemModelo = new Map(), itensComModelo = new Map()
    for (const r of ativos) for (const a of r.anuncios) {
      if (a.plataforma === 'mercadolivre') { if (!porContaML.has(a._c.id)) porContaML.set(a._c.id, { conta: a._c, ids: new Set() }); porContaML.get(a._c.id).ids.add(a.anuncio_id) }
      else if (a.variacao_id) { const k = `${a._c.id}:${a.anuncio_id}`; if (!itensComModelo.has(k)) itensComModelo.set(k, { conta: a._c, item: a.anuncio_id }) }
      else { if (!itensSemModelo.has(a._c.id)) itensSemModelo.set(a._c.id, { conta: a._c, ids: new Set() }); itensSemModelo.get(a._c.id).ids.add(a.anuncio_id) }
    }
    const leitura = new Map()
    for (const { conta, ids } of porContaML.values()) for (const lote of pedacos([...ids], 20)) {
      let mapa = null, erro = null
      try { mapa = await ml.lerAnuncios(conta, lote) } catch (e) { erro = e.message }
      for (const id of lote) leitura.set(`ml:${conta.id}:${id}`, mapa ? (mapa.get(id) || { erro: 'anúncio não devolvido pelo ML' }) : { erro })
      await dormir()
    }
    for (const { conta, ids } of itensSemModelo.values()) for (const lote of pedacos([...ids], 20)) {
      let mapa = null, erro = null
      try { mapa = await shopee.lerItens(conta, lote) } catch (e) { erro = e.message }
      for (const id of lote) leitura.set(`sh:${conta.id}:${id}:`, mapa ? (mapa.get(id) || { erro: 'item não devolvido pela Shopee' }) : { erro })
      await dormir()
    }
    const modelos = new Map()
    for (const [k, { conta, item }] of itensComModelo) {
      try { modelos.set(k, await shopee.lerModelos(conta, item)) } catch (e) { modelos.set(k, { erro: e.message }) }
      await dormir()
    }
    for (const r of ativos) {
      for (const a of r.anuncios) {
        let l
        if (a.plataforma === 'mercadolivre') l = leitura.get(`ml:${a._c.id}:${a.anuncio_id}`) || { erro: 'sem leitura' }
        else if (!a.variacao_id) l = leitura.get(`sh:${a._c.id}:${a.anuncio_id}:`) || { erro: 'sem leitura' }
        else { const m = modelos.get(`${a._c.id}:${a.anuncio_id}`); l = !m ? { erro: 'sem leitura' } : m.erro ? { erro: m.erro } : (m.get(a.variacao_id) || { erro: 'variação não devolvida pela Shopee' }) }
        a.lido_em = lidoEm
        if (l.erro || l.quantidade === null || l.quantidade === undefined) { a.erro = l.erro || 'sem quantidade'; a.quantidade = null; continue }
        a.quantidade = l.quantidade
        if (a.plataforma === 'mercadolivre') {
          a.titulo = l.titulo ?? null; a.variacoes = l.variacoes || 0; a.sku_declarado = l.sku_declarado || a.anuncio_id
          // anúncio FULL (inventory_id no /items): o número dele é o estoque do armazém do ML — nunca serve de origem do normal
          if (l.inventory_id) { a.full = true; a.inventory_id = l.inventory_id }
        }
        else {
          const b = l.bruto || {}; const si = b.stock_info_v2 || {}
          a.tem_variacao = !!l.tem_variacao; a.reserva = l.reservada ?? null
          a.estoque_vendedor = somaEstoque(si.seller_stock); a.estoque_shopee = somaEstoque(si.shopee_stock)
          a.sku_declarado = a.variacao_id ? String(b.model_sku || `${a.anuncio_id}-${a.variacao_id}`).trim() : String(b.item_sku || a.anuncio_id).trim()
          if (a.estoque_shopee > 0) a.full = true   // estoque no armazém da Shopee: não é estoque do vendedor
        }
      }
      const comErro = r.anuncios.find((a) => a.erro); if (comErro) { bloquear(r.sku, `falha ao ler ${nome(comErro)}: ${comErro.erro}`); continue }
      const varML = r.anuncios.find((a) => a.plataforma === 'mercadolivre' && a.variacoes > 0); if (varML) { bloquear(r.sku, `anúncio ${nome(varML)} tem ${varML.variacoes} variação(ões) no ML — o número é a soma das variações`); continue }
      const semModelo = r.anuncios.find((a) => a.plataforma === 'shopee' && !a.variacao_id && a.tem_variacao); if (semModelo) { bloquear(r.sku, `item Shopee ${semModelo.anuncio_id} tem variações, mas o vínculo está sem model_id — não dá para saber a variação`); continue }
      const skuErrado = r.anuncios.find((a) => a.sku_declarado !== a.sku_original)   // SKU original do vínculo (agrupado ou não)
      if (skuErrado) { bloquear(r.sku, `${nome(skuErrado)} declara o SKU "${skuErrado.sku_declarado}", diferente do vínculo "${skuErrado.sku_original}"`); continue }
      const reserva = r.anuncios.find((a) => a.plataforma === 'shopee' && a.reserva !== null && a.reserva > 0)
      if (reserva) { bloquear(r.sku, `${nome(reserva)} tem ${reserva.reserva} unidade(s) reservada(s) para promoção — o número não representa o estoque físico e a Shopee não aceitaria menos que a reserva`); continue }
      const semVend = r.anuncios.find((a) => a.plataforma === 'shopee' && !a.full && a.estoque_vendedor === null); if (semVend) { bloquear(r.sku, `a Shopee não informou o estoque do vendedor de ${nome(semVend)} — não dá para conferir`); continue }
      const vendDif = r.anuncios.find((a) => a.plataforma === 'shopee' && !a.full && a.estoque_vendedor !== a.quantidade)
      if (vendDif) { bloquear(r.sku, `${nome(vendDif)}: estoque do vendedor ${vendDif.estoque_vendedor} diferente do disponível ${vendDif.quantidade} — números da Shopee não batem`); continue }
      const comparaveis = r.anuncios.filter((a) => !a.full)
      const daOrigem = comparaveis.filter((a) => origem.has(a.conta_ref))
      if (!daOrigem.length) { bloquear(r.sku, 'nas contas/lojas selecionadas o anúncio é Full/FBS (estoque no armazém da plataforma) — não serve de origem'); continue }
      const numeros = [...new Set(comparaveis.map((a) => a.quantidade))]
      if (numeros.length > 1) { bloquear(r.sku, 'Anúncios discordam: ' + comparaveis.map((a) => `${nome(a)} = ${a.quantidade}`).join(' · ')); continue }
      r.numero_lido = numeros[0]; r.anuncio_origem = `${daOrigem[0].plataforma}:${daOrigem[0].anuncio_id}${daOrigem[0].variacao_id ? '/' + daOrigem[0].variacao_id : ''}`
      r.contas_origem = [...new Set(daOrigem.map((a) => `${ROTULO_PLAT[a.plataforma]} ${a.conta}`))]
      if (!Number.isInteger(r.numero_lido) || r.numero_lido < 0) { bloquear(r.sku, `número inválido no anúncio (${r.numero_lido})`); continue }
      if (r.numero_lido > limiteQuantidade) { bloquear(r.sku, `número do anúncio (${r.numero_lido}) acima do limite provisório de ${limiteQuantidade} — revisão manual (pode ser número de preenchimento, não estoque físico)`); continue }
      if (Number(r.tmp10) >= 0 && r.numero_lido === Number(r.tmp10)) { r.situacao = 'igual'; r.motivo = 'o TMP10 já tem este número'; continue }
      r.situacao = 'apto'; r.novo = r.numero_lido
    }

    // 3) pedidos — DEPOIS da leitura, só para os aptos
    const aptos = [...res.values()].filter((r) => r.situacao === 'apto')
    if (aptos.length) {
      const refsEnv = new Set(aptos.flatMap((r) => r.anuncios.map((a) => a.conta_ref)))
      const contasEnv = contas.filter((c) => refsEnv.has(refDe(c)))
      await atualizarPedidos(ctx, contasEnv)
      verificarPedidos(ctx, aptos, bloquear)
    }
    for (const r of res.values()) { delete r._originais; for (const a of r.anuncios) { delete a._l; delete a._c } }
    return res
  }

  function verificarPedidos(ctx, aptos, bloquear) {
    const cancSh = new Set(statusCanceladoShopee())
    for (const r of aptos) {
      const idsML = new Set(r.anuncios.filter((a) => a.plataforma === 'mercadolivre').map((a) => a.anuncio_id))
      const shSemModelo = new Set(r.anuncios.filter((a) => a.plataforma === 'shopee' && !a.variacao_id).map((a) => a.anuncio_id))
      const shComModelo = new Set(r.anuncios.filter((a) => a.plataforma === 'shopee' && a.variacao_id).map((a) => a.anuncio_id))
      // (D) falha de consulta numa conta/loja do SKU
      const falha = r.anuncios.map((a) => ctx.erroConta.get(a.conta_ref)).find(Boolean)
      if (falha) { bloquear(r.sku, falha); continue }
      // afeta o SKU? pelo SKU do item, ou pelo anúncio (Shopee com variação: só pelo SKU — o item tem outras variações)
      const orig = r._originais || new Set([r.sku])   // o próprio SKU + os SKUs originais agrupados nele
      const afetaML = (sku, anuncio) => (sku && orig.has(sku)) || (anuncio && idsML.has(String(anuncio)))
      const afetaSh = (sku, item) => (sku && orig.has(sku)) || (item && shSemModelo.has(String(item))) || (item && shComModelo.has(String(item)) && (!sku || sku === String(item)))
      // (A) não importados
      for (const p of ctx.naoImportados.values()) {
        if (p.plataforma === 'shopee' && p.fbs) continue
        const its = p.plataforma === 'shopee' ? p.itens.filter((it) => afetaSh(it.sku, it.item_id)) : p.itens.filter((it) => afetaML(it.sku, it.anuncio))
        if (its.length) {
          const un = its.reduce((t, it) => t + (it.qtd || 1), 0)
          r.pedidos.push({ verificacao: 'A', canal: p.plataforma, conta: p.conta, pedido: p.id || p.sn, status: p.status, unidades: un })
          bloquear(r.sku, `pedido ${ROTULO_PLAT[p.plataforma]} ${p.id || p.sn} (${p.status || 'status ?'}, ${un} un., ${p.conta}) ainda não importado no TMP10`)
          break
        }
      }
      if (r.situacao !== 'apto') continue
      // (B) e (C) com os pedidos do TMP10
      for (const o of ctx.pedidosTmp || []) {
        if (o.is_fulfillment === true || o.status === 'cancelado') continue
        const plat = o.platform === 'shopee' ? 'shopee' : 'mercadolivre'
        const its = (Array.isArray(o.items) ? o.items : []).map((it) => ({ sku: it && it.sku ? String(it.sku).trim() : null, anuncio: it && it.ml_item_id !== undefined && it.ml_item_id !== null ? String(it.ml_item_id) : null }))
        const doSku = its.filter((it) => (plat === 'shopee' ? afetaSh(it.sku, it.anuncio) : afetaML(it.sku, it.anuncio)))
        if (!doSku.length) continue
        const outro = doSku.find((it) => it.sku && !orig.has(it.sku) && (plat === 'mercadolivre' ? idsML.has(it.anuncio) : shSemModelo.has(it.anuncio)))
        if (outro) { r.pedidos.push({ verificacao: 'B', canal: plat, pedido: o.ml_order_id, sku: outro.sku }); bloquear(r.sku, `venda do anúncio ${outro.anuncio} registrada com outro SKU ("${outro.sku}") — pedido ${o.ml_order_id}: vínculo ou cadastro inconsistente`); break }
        if (plat === 'mercadolivre') {
          if (!['finalizado', 'full_ml'].includes(o.status) && [...ctx.ml.values()].some((st) => st.cancelados.has(String(o.ml_order_id)))) {
            r.pedidos.push({ verificacao: 'C', canal: plat, pedido: o.ml_order_id }); bloquear(r.sku, `pedido ML ${o.ml_order_id} está cancelado/invalidado no ML e ainda aberto no TMP10 (cancelamento não processado)`); break
          }
        } else {
          const st = ctx.statusSh.get(String(o.ml_order_id))
          if (st && cancSh.has(st)) { r.pedidos.push({ verificacao: 'C', canal: plat, pedido: o.ml_order_id, status: st }); bloquear(r.sku, `pedido Shopee ${o.ml_order_id} está "${st}" na Shopee e ainda aberto no TMP10 (cancelamento não processado)`); break }
          if (st === undefined) r._shPendentesStatus = (r._shPendentesStatus || []).concat([{ sn: String(o.ml_order_id), conta: o.account_nickname }])
        }
        if (!ctx.corte || new Date(o.created_at_ml) >= ctx.corte) {
          for (const s of new Set(doSku.filter((it) => it.sku && orig.has(it.sku)).map((it) => it.sku))) r._refsVenda = (r._refsVenda || []).concat([`venda:${plat}:${o.ml_order_id}:${s}`])
        }
      }
    }
  }

  // completa (C) status Shopee dos pedidos abertos e (B) movimentos de venda — partes que precisam de consulta
  async function completarPedidos(empresaId, ctx, res) {
    const aptos = [...res.values()].filter((r) => r.situacao === 'apto')
    const contas = await todasContas(empresaId)
    const cancSh = new Set(statusCanceladoShopee())
    const bloq = (r, motivo) => { if (r.situacao === 'apto') { r.situacao = 'bloqueado'; r.motivo = motivo } }
    const porLoja = new Map()
    for (const r of aptos) for (const x of (r._shPendentesStatus || [])) {
      const conta = contas.find((c) => c.platform === 'shopee' && c.nickname === x.conta)
      if (!conta) { bloq(r, `loja ${x.conta || '?'} do pedido ${x.sn} não conectada — não dá para conferir cancelamento`); continue }
      if (!porLoja.has(conta.id)) porLoja.set(conta.id, { conta, sns: new Set() }); porLoja.get(conta.id).sns.add(x.sn)
    }
    for (const { conta, sns } of porLoja.values()) {
      try { for (const lote of pedacos([...sns].filter((s) => !ctx.statusSh.has(s)), 50)) { for (const d of await shopee.detalharPedidos(conta, lote)) ctx.statusSh.set(d.sn, d.status); await dormir() } }
      catch (e) { for (const r of aptos) if ((r._shPendentesStatus || []).some((x) => sns.has(x.sn))) bloq(r, `não foi possível conferir pedidos da loja ${conta.nickname}: ${e.message}`) }
    }
    for (const r of aptos) {
      const canc = (r._shPendentesStatus || []).find((x) => cancSh.has(ctx.statusSh.get(x.sn)))
      if (canc) { bloq(r, `pedido Shopee ${canc.sn} está "${ctx.statusSh.get(canc.sn)}" na Shopee e ainda aberto no TMP10 (cancelamento não processado)`); r.pedidos.push({ verificacao: 'C', canal: 'shopee', pedido: canc.sn }) }
    }
    const refs = [...new Set(aptos.filter((r) => r.situacao === 'apto').flatMap((r) => r._refsVenda || []))]
    const movs = new Map()
    for (const lote of pedacos(refs, 200)) for (const m of (await q(sb.from('estoque_movimentos').select('referencia, aplicado, observacao').eq('empresa_id', empresaId).in('referencia', lote), 'movimentos de venda')) || []) movs.set(m.referencia, m)
    for (const r of aptos) {
      if (r.situacao === 'apto') {
        for (const ref of (r._refsVenda || [])) {
          const m = movs.get(ref); const ped = ref.split(':')[2]
          if (!m) { bloq(r, `pedido ${ped} importado mas SEM baixa registrada no TMP10`); r.pedidos.push({ verificacao: 'B', pedido: ped, sem_baixa: true }); break }
          if (!m.aplicado) r.avisos.push(`pedido ${ped}: venda registrada sem baixa (${m.observacao || 'não aplicada'})`)
        }
      }
      if (r.situacao === 'apto') r.pedidos_conferidos_em = agora().toISOString()
      delete r._refsVenda; delete r._shPendentesStatus; delete r._originais
    }
  }

  async function avaliarCompleto(empresaId, skus, refsOrigem, ctx = novoContexto(empresaId)) {
    const res = await avaliar(empresaId, skus, refsOrigem, ctx)
    await completarPedidos(empresaId, ctx, res)
    return res
  }

  function previaFila(r, cfg) {
    return r.anuncios.map((a) => { const d = decidirEnvio(cfg, r.sku, { agrupado: !!(a.sku_original && a.sku_original !== r.sku) })
      return { canal: a.plataforma, conta: a.conta, anuncio_id: a.anuncio_id + (a.variacao_id ? '/' + a.variacao_id : ''), atual: a.quantidade, novo: r.novo,
        envio: a.full ? 'bloqueado (Full/FBS)' : (d.real ? 'real' : 'simulado'), motivo: a.full ? 'estoque fica com a plataforma' : d.motivo } })
  }
  async function registrarEventos(linhas) { for (const lote of pedacos(linhas, 200)) await q(sb.from('estoque_ajuste_massa_eventos').insert(lote), 'auditoria do ajuste em massa') }
  async function eventosDe(id, modo) {
    return lerTodos(() => sb.from('estoque_ajuste_massa_eventos').select('id, sku, modo, tentativa, resultado, motivo, numero_lido, estoque_anterior, estoque_novo, anuncio_id, produto_id, movimento_id, detalhe, criado_em')
      .eq('execucao_id', id).eq('modo', modo).order('id', { ascending: true }), 'eventos')
  }
  const ultimoPorSku = (evs) => { const m = new Map(); for (const e of evs) m.set(e.sku, e); return m }

  // ── SIMULAÇÃO (segundo plano, em lotes; retomável) ──────────────────────────────────────────────────────────────
  async function validarContas(empresaId, contaRef, contasRef) {
    const refs = refsDe(contaRef, contasRef)
    if (!refs.length) throw erroHttp('Selecione ao menos uma conta do Mercado Livre ou loja da Shopee.', 400)
    const todas = await todasContas(empresaId)
    const contas = refs.map((r) => todas.find((c) => refDe(c) === r))
    if (contas.some((c) => !c)) throw erroHttp('Conta/loja não encontrada nesta empresa.', 400)
    return contas
  }
  function filtrar(lista, filtro, busca) {
    const qb = String(busca || '').trim().toLowerCase()
    return lista.filter((i) => (!qb || i.sku.toLowerCase().includes(qb) || String(i.nome || '').toLowerCase().includes(qb) || i.anuncios.some((a) => String(a.anuncio_id).toLowerCase().includes(qb) || String(a.sku_original || '').toLowerCase().includes(qb)))
      && (!filtro || filtro === 'todos' || (filtro === 'divergencia' ? i.com_divergencia : !i.com_divergencia)))
  }
  async function resolverSkus({ empresaId, refs, skus, todos }) {
    if (todos && typeof todos === 'object') {   // "SELECIONAR TODOS" resolvido no SERVIDOR (mesmo filtro e pesquisa da tela)
      const l = await itens({ empresaId, contasRef: refs })
      const ex = new Set((Array.isArray(todos.excluir) ? todos.excluir : []).map(String))
      return filtrar(l.itens, todos.filtro, todos.busca).filter((i) => i.selecionavel && !ex.has(i.sku)).map((i) => i.sku)
    }
    return [...new Set((Array.isArray(skus) ? skus : []).map((s) => String(s).trim()).filter(Boolean))]
  }

  async function prepararSimulacao({ empresaId, usuarioId, contaRef, contasRef, skus, todos, id = crypto.randomUUID() }) {
    const contas = await validarContas(empresaId, contaRef, contasRef)
    const refs = contas.map(refDe)
    const lista = await resolverSkus({ empresaId, refs, skus, todos })
    if (!lista.length) throw erroHttp('Selecione ao menos um produto.', 400)
    if (simulandoEmpresa.has(empresaId)) throw erroHttp('Já existe uma simulação em andamento nesta empresa — aguarde ou acompanhe o progresso.', 409)
    const cfg = await lerConfig(empresaId)
    const plats = [...new Set(contas.map((c) => (c.platform === 'shopee' ? 'shopee' : 'mercadolivre')))]
    const cab = { id, empresa_id: empresaId, usuario_id: usuarioId || null, plataforma: plats.length > 1 ? 'multi' : plats[0], conta_ref: refs.join(','),
      conta_nome: contas.map((c) => c.nickname).join(', '), limite_quantidade: limiteQuantidade, itens: lista,
      resumo: { total: lista.length, contas: contas.map((c) => ({ ref: refDe(c), nome: c.nickname, plataforma: c.platform === 'shopee' ? 'shopee' : 'mercadolivre' })), modo_na_simulacao: cfg.modo,
        aviso: AVISO_FIXO, limite_quantidade: limiteQuantidade, lote: LOTE_SIMULACAO, selecao: todos ? 'todos (resolvido no servidor)' : 'lista' },
      expira_em: new Date(agora().getTime() + VALIDADE_MAXIMA_HORAS * 3600000).toISOString() }
    await q(sb.from('estoque_ajuste_massa_execucoes').insert(cab), 'registrar simulação')
    return cab
  }

  async function rodarSimulacao(cab, { usuarioId } = {}) {
    const empresaId = cab.empresa_id
    if (simulandoEmpresa.has(empresaId)) throw erroHttp('Já existe uma simulação em andamento nesta empresa.', 409)
    simulandoEmpresa.add(empresaId)
    const job = { tipo: 'simulacao', fase: 'simulando', total: cab.itens.length, processados: 0, simulado: 0, igual: 0, bloqueado: 0, falha: 0, iniciado_em: agora().toISOString(), empresa_id: empresaId }
    jobs.set(cab.id, job)
    try {
      const ja = ultimoPorSku(await eventosDe(cab.id, 'simulacao'))
      const pendentes = cab.itens.filter((s) => !ja.has(s) || ja.get(s).resultado === 'falha')
      for (const e of ja.values()) if (e.resultado !== 'falha') { job[e.resultado]++; job.processados++ }
      const refs = cab.conta_ref.split(',')
      const ctx = novoContexto(empresaId)
      const tentativa = 1 + (ja.size ? Math.max(...[...ja.values()].map((e) => e.tentativa || 1)) : 0)
      const cfg = await lerConfig(empresaId)
      for (const lote of pedacos(pendentes, LOTE_SIMULACAO)) {
        let linhas
        try {
          const res = await avaliarCompleto(empresaId, lote, refs, ctx)
          linhas = lote.map((sku) => {
            const r = res.get(sku)
            const resultado = r.situacao === 'apto' ? 'simulado' : r.situacao === 'igual' ? 'igual' : 'bloqueado'
            return { execucao_id: cab.id, empresa_id: empresaId, usuario_id: usuarioId || cab.usuario_id || null, modo: 'simulacao', tentativa, sku, produto_id: r.produto_id || null,
              plataforma: r.anuncio_origem ? r.anuncio_origem.split(':')[0] : null, conta_ref: cab.conta_ref, anuncio_id: r.anuncio_origem || null, numero_lido: r.numero_lido ?? null,
              estoque_anterior: r.tmp10 ?? null, estoque_novo: r.situacao === 'apto' ? r.novo : null, resultado, motivo: r.motivo,
              detalhe: { nome: r.nome || null, anuncios: r.anuncios, contas_origem: r.contas_origem || [], pedidos: r.pedidos, avisos: [...new Set(r.avisos)],
                pedidos_conferidos_em: r.pedidos_conferidos_em || null, diferenca: r.situacao === 'apto' ? r.novo - Number(r.tmp10) : null, fila: r.situacao === 'apto' ? previaFila(r, cfg) : [] } }
          })
        } catch (e) {   // falha do lote: registra e segue; "Retomar" refaz só estes
          log(`⚠️ [ESTOQUE] ajuste em massa ${cab.id}: lote falhou (${e.message})`)
          linhas = lote.map((sku) => ({ execucao_id: cab.id, empresa_id: empresaId, usuario_id: usuarioId || cab.usuario_id || null, modo: 'simulacao', tentativa, sku, resultado: 'falha', motivo: `falha ao simular: ${e.message}` }))
        }
        await registrarEventos(linhas)
        for (const l of linhas) job[l.resultado]++
        job.processados += lote.length
      }
      job.fase = 'concluida'
      log(`📋 [ESTOQUE] ajuste em massa: simulação ${cab.id} — ${JSON.stringify({ total: job.total, elegiveis: job.simulado, iguais: job.igual, bloqueados: job.bloqueado, falhas: job.falha })}`)
      return job
    } catch (e) { Object.assign(job, { fase: 'erro', erro: e.message }); throw e }
    finally { job.terminado_em = agora().toISOString(); simulandoEmpresa.delete(empresaId) }
  }

  async function simular(args) {   // uso direto/testes: simula e devolve o resultado completo
    const cab = await prepararSimulacao(args)
    await rodarSimulacao(cab, args)
    const st = await status(args.empresaId, cab.id)
    const pag = await itensDaExecucao(args.empresaId, cab.id, { porPagina: 100000 })
    return { execucao_id: cab.id, resumo: st.simulacao, itens: pag.itens, expira_em: st.expira_em }
  }
  async function iniciarSimulacao(args) {
    const cab = await prepararSimulacao(args)
    rodarSimulacao(cab, args).catch((e) => log(`❌ [ESTOQUE] ajuste em massa: simulação ${cab.id}: ${e.message}`))
    return { execucao_id: cab.id, total: cab.itens.length }
  }
  async function retomarSimulacao({ empresaId, usuarioId, execucaoId, aguardar = false }) {
    const cab = await carregarExecucao(empresaId, execucaoId)
    if (simulandoEmpresa.has(empresaId)) throw erroHttp('Já existe uma simulação em andamento nesta empresa.', 409)
    const p = rodarSimulacao(cab, { usuarioId })
    if (aguardar) { await p; return { execucao_id: cab.id } }
    p.catch((e) => log(`❌ [ESTOQUE] ajuste em massa: retomada da simulação ${cab.id}: ${e.message}`))
    return { execucao_id: cab.id }
  }

  // ── EXECUÇÃO / RETOMADA (lotes; trava por empresa; idempotente) ────────────────────────────────────────────────────
  async function carregarExecucao(empresaId, id) {
    if (!ehUuid(id)) throw erroHttp('Informe a simulação (execucao_id).', 400)
    const ex = await q(sb.from('estoque_ajuste_massa_execucoes').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle(), 'simulação')
    if (!ex) throw erroHttp('Simulação não encontrada.', 404)
    if (!Array.isArray(ex.itens) || ex.itens.some((x) => typeof x !== 'string')) throw erroHttp('Simulação em formato antigo — simule de novo.', 409)
    return ex
  }
  const referenciaDe = (id, sku) => `massa:${id}:${sku}`
  async function movimentosDaExecucao(empresaId, id) {
    const ms = await lerTodos(() => sb.from('estoque_movimentos').select('id, referencia, aplicado, estoque_anterior, estoque_novo, criado_em').eq('empresa_id', empresaId).like('referencia', `massa:${id}:%`), 'movimentos da execução')
    return new Map(ms.map((m) => [m.referencia, m]))
  }
  async function preparar({ empresaId, execucaoId }) {
    const ex = await carregarExecucao(empresaId, execucaoId)
    const job = jobs.get(ex.id)
    if (job && job.tipo === 'simulacao' && job.fase === 'simulando') throw erroHttp('A simulação ainda está rodando.', 409)
    const sim = ultimoPorSku(await eventosDe(ex.id, 'simulacao'))
    const faltam = ex.itens.filter((s) => !sim.has(s)).length
    if (faltam) throw erroHttp(`A simulação não terminou (${faltam} de ${ex.itens.length} produtos sem resultado) — retome a simulação antes de confirmar.`, 409)
    const fim = Math.max(...[...sim.values()].map((e) => new Date(e.criado_em).getTime()))
    if (new Date(ex.expira_em) < agora() || fim + VALIDADE_MINUTOS * 60000 < agora().getTime()) throw erroHttp('A simulação venceu (60 minutos depois de terminar). Simule de novo.', 409)
    if (executandoEmpresa.has(empresaId)) throw erroHttp('Já existe um ajuste em massa em andamento nesta empresa.', 409)
    if (!(await rpc('estoque_ajuste_massa_travar', { p_empresa: empresaId, p_execucao: ex.id, p_dono: dono, p_segundos: TRAVA_SEGUNDOS }))) throw erroHttp('Já existe um ajuste em massa em andamento nesta empresa.', 409)
    executandoEmpresa.add(empresaId)
    return { ex, sim }
  }
  async function executar(args) { const p = await preparar(args); return rodar(p, args) }
  async function iniciarExecucao(args) {
    const p = await preparar(args)
    rodar(p, args).catch((e) => log(`❌ [ESTOQUE] ajuste em massa ${p.ex.id}: ${e.message}`))
    return { execucao_id: p.ex.id }
  }

  async function rodar({ ex, sim }, { empresaId, usuarioId }) {
    const aptos = [...sim.values()].filter((e) => e.resultado === 'simulado').map((e) => ({ sku: e.sku, produto_id: e.produto_id, tmp10_antes: e.estoque_anterior, novo: e.estoque_novo,
      numero_lido: e.numero_lido, anuncio_origem: e.anuncio_id, contas_origem: (e.detalhe && e.detalhe.contas_origem) || [] }))
    const job = { tipo: 'execucao', fase: 'executando', total: aptos.length, processados: 0, aplicado: 0, ja_aplicado: 0, bloqueado: 0, igual: 0, falha: 0, iniciado_em: agora().toISOString(), empresa_id: empresaId }
    jobs.set(ex.id, job)
    const resultado = []
    try {
      const anteriores = await eventosDe(ex.id, 'execucao')
      const tentativa = 1 + (anteriores.length ? Math.max(...anteriores.map((e) => e.tentativa || 1)) : 0)
      const jaEvento = new Set(anteriores.filter((e) => ['aplicado', 'ja_aplicado'].includes(e.resultado)).map((e) => e.sku))
      const movs = await movimentosDaExecucao(empresaId, ex.id)
      const evento = (i, res, motivo, extra = {}) => ({ execucao_id: ex.id, empresa_id: empresaId, usuario_id: usuarioId || null, modo: 'execucao', tentativa,
        sku: i.sku, produto_id: i.produto_id, plataforma: i.anuncio_origem ? i.anuncio_origem.split(':')[0] : null, conta_ref: ex.conta_ref, anuncio_id: i.anuncio_origem, numero_lido: extra.numero_lido ?? null,
        estoque_anterior: extra.anterior ?? i.tmp10_antes, estoque_novo: extra.novo ?? i.novo, resultado: res, motivo, detalhe: extra.detalhe || null, movimento_id: extra.movimento_id || null })
      const pendentes = []
      const evIniciais = []
      for (const i of aptos) {
        const m = movs.get(referenciaDe(ex.id, i.sku))
        if (m && m.aplicado) { if (!jaEvento.has(i.sku)) { evIniciais.push(evento(i, 'ja_aplicado', 'movimento já existia (retomada após interrupção)', { movimento_id: m.id, anterior: m.estoque_anterior, novo: m.estoque_novo })); job.ja_aplicado++ } job.processados++ }
        else pendentes.push(i)
      }
      if (evIniciais.length) { await registrarEventos(evIniciais); resultado.push(...evIniciais) }
      const todas = await todasContas(empresaId)
      const refs = ex.conta_ref.split(',')
      if (refs.some((r) => !todas.find((c) => refDe(c) === r))) {
        const evs = pendentes.map((i) => evento(i, 'bloqueado', 'uma das contas/lojas da simulação não está mais conectada nesta empresa — simule de novo'))
        await registrarEventos(evs); resultado.push(...evs); job.processados += pendentes.length; job.bloqueado += pendentes.length
      } else {
        const ctx = novoContexto(empresaId)
        for (const lote of pedacos(pendentes, LOTE_EXECUCAO)) {
          const evs = []
          let aval
          try { aval = await avaliarCompleto(empresaId, lote.map((i) => i.sku), refs, ctx) } catch (e) {
            for (const i of lote) evs.push(evento(i, 'falha', `falha ao revalidar: ${e.message}`))
          }
          if (aval) for (const i of lote) {
            const r = aval.get(i.sku)
            let ev
            try {
              if (r.situacao !== 'apto') ev = evento(i, r.situacao === 'igual' ? 'igual' : 'bloqueado', `revalidação: ${r.motivo}`, { numero_lido: r.numero_lido ?? null, detalhe: { anuncios: r.anuncios, pedidos: r.pedidos } })
              else if (r.numero_lido !== i.novo) ev = evento(i, 'bloqueado', `o número dos anúncios mudou de ${i.novo} para ${r.numero_lido} desde a simulação — simule de novo`, { numero_lido: r.numero_lido })
              else {
                const mov = await movimentar({ empresaId, sku: i.sku, tipo: 'definir', quantidade: i.novo, origem: 'ajuste_massa',
                  motivo: `Ajuste em massa: número dos marketplaces (${(i.contas_origem && i.contas_origem.length ? i.contas_origem.join(', ') : ex.conta_nome)}, anúncio ${i.anuncio_origem}) — execução ${ex.id}`,
                  referencia: referenciaDe(ex.id, i.sku), usuarioId, processo: 'erp', esperado: i.tmp10_antes })
                if (mov && mov.aplicado && mov.duplicado) ev = evento(i, 'ja_aplicado', 'movimento já existia', { movimento_id: mov.movimento_id, anterior: mov.anterior, novo: mov.novo, numero_lido: r.numero_lido })
                else if (mov && mov.aplicado) {
                  ev = evento(i, 'aplicado', null, { movimento_id: mov.movimento_id, anterior: mov.anterior, novo: mov.novo, numero_lido: r.numero_lido })
                  try {
                    await q(sb.from('estoque_divergencias').update({ resolvido: true, resolucao: 'ajuste_massa', resolvido_em: agora().toISOString(), resolvido_por: usuarioId || null })
                      .eq('empresa_id', empresaId).eq('sku', i.sku).not('chave', 'is', null).not('resolvido', 'is', true), 'resolver divergências')
                  } catch (e) { log(`[ESTOQUE] ajuste em massa: não resolveu divergências de ${i.sku}: ${e.message}`) }
                } else if (mov && mov.erro === 'estoque_mudou') ev = evento(i, 'bloqueado', `o estoque do TMP10 mudou para ${mov.anterior} desde a simulação — simule de novo`, { anterior: mov.anterior, novo: null })
                else ev = evento(i, 'falha', `não aplicado: ${(mov && mov.erro) || 'erro'}`)
              }
            } catch (e) { ev = evento(i, 'falha', e.message) }
            evs.push(ev)
          }
          await registrarEventos(evs); resultado.push(...evs)
          for (const e of evs) job[e.resultado]++
          job.processados += lote.length
          if (!(await rpc('estoque_ajuste_massa_renovar', { p_empresa: empresaId, p_execucao: ex.id, p_dono: dono, p_segundos: TRAVA_SEGUNDOS }))) {
            log(`⚠️ [ESTOQUE] ajuste em massa ${ex.id}: trava perdida — interrompido; use "Retomar pendentes"`); job.erro = 'trava perdida — retome os pendentes'; break
          }
        }
      }
      job.fase = 'concluida'
      log(`✅ [ESTOQUE] ajuste em massa ${ex.id}: ${job.aplicado} aplicado(s), ${job.bloqueado} bloqueado(s), ${job.falha} falha(s)`)
      return { execucao_id: ex.id, tentativa, resultados: resultado }
    } catch (e) { Object.assign(job, { fase: 'erro', erro: e.message }); throw e }
    finally {
      job.terminado_em = agora().toISOString()
      executandoEmpresa.delete(empresaId)
      try { await rpc('estoque_ajuste_massa_liberar', { p_empresa: empresaId, p_execucao: ex.id, p_dono: dono }) } catch (e) { log(`[ESTOQUE] ajuste em massa: trava não liberada (${e.message}) — expira em ${TRAVA_SEGUNDOS}s`) }
    }
  }

  // ── Situação: contagens (banco = fonte da verdade) + andamento em memória ─────────────────────────────────────────
  async function situacaoPorSku(empresaId, ex) {
    return { sim: ultimoPorSku(await eventosDe(ex.id, 'simulacao')), exe: ultimoPorSku(await eventosDe(ex.id, 'execucao')), movs: await movimentosDaExecucao(empresaId, ex.id) }
  }
  function situacaoExecucao(sku, simEv, exeEv, movs, id) {
    if (!simEv || simEv.resultado !== 'simulado') return null
    const m = movs.get(referenciaDe(id, sku))
    if (m && m.aplicado) return { situacao: 'aplicado', anterior: m.estoque_anterior, novo: m.estoque_novo, em: m.criado_em }
    if (exeEv && exeEv.resultado === 'bloqueado') return { situacao: 'bloqueado', motivo: exeEv.motivo }
    if (exeEv && exeEv.resultado === 'igual') return { situacao: 'igual', motivo: exeEv.motivo }
    if (exeEv && exeEv.resultado === 'falha') return { situacao: 'pendente', motivo: `falhou: ${exeEv.motivo}` }
    return { situacao: 'pendente', motivo: null }
  }
  async function status(empresaId, id) {
    if (!ehUuid(id)) throw erroHttp('Informe a simulação.', 400)
    const ex = await q(sb.from('estoque_ajuste_massa_execucoes').select('id, empresa_id, conta_ref, conta_nome, plataforma, itens, resumo, criado_em, expira_em').eq('id', id).eq('empresa_id', empresaId).maybeSingle(), 'simulação')
    if (!ex) throw erroHttp('Simulação não encontrada.', 404)
    const job = jobs.get(id)
    // foto do andamento ANTES de ler os eventos: se o lote final gravar entre a leitura e a resposta, ainda aparece
    // "em andamento" (a próxima consulta mostra "concluída") — nunca "interrompida" por engano
    const rodando = !!(job && job.tipo === 'simulacao' && job.fase === 'simulando')
    const execRodando = !!(job && job.tipo === 'execucao' && job.fase === 'executando')
    const { sim, exe, movs } = await situacaoPorSku(empresaId, ex)
    const total = (ex.itens || []).length
    const c = { simulado: 0, igual: 0, bloqueado: 0, falha: 0 }
    for (const e of sim.values()) c[e.resultado]++
    const fim = sim.size ? Math.max(...[...sim.values()].map((e) => new Date(e.criado_em).getTime())) : null
    const estado = rodando ? 'em_andamento' : (sim.size < total || c.falha > 0) ? 'interrompida' : 'concluida'
    const vencida = new Date(ex.expira_em) < agora() || (estado === 'concluida' && fim + VALIDADE_MINUTOS * 60000 < agora().getTime())
    const e = { aplicados: 0, bloqueados: 0, iguais: 0, pendentes: 0 }
    for (const [sku, ev] of sim) {
      const s = situacaoExecucao(sku, ev, exe.get(sku), movs, id)
      if (!s) continue
      if (s.situacao === 'aplicado') e.aplicados++; else if (s.situacao === 'bloqueado') e.bloqueados++; else if (s.situacao === 'igual') e.iguais++; else e.pendentes++
    }
    return { execucao_id: id, contas: (ex.resumo && ex.resumo.contas) || [], conta_nome: ex.conta_nome, plataforma: ex.plataforma, criado_em: ex.criado_em,
      expira_em: fim ? new Date(Math.min(new Date(ex.expira_em).getTime(), fim + VALIDADE_MINUTOS * 60000)).toISOString() : ex.expira_em, vencida,
      simulacao: { estado, total, processados: sim.size, faltam: total - sim.size, elegiveis: c.simulado, iguais: c.igual, bloqueados: c.bloqueado, falhas: c.falha,
        modo: ex.resumo && ex.resumo.modo_na_simulacao, aviso: AVISO_FIXO, limite_quantidade: ex.resumo && ex.resumo.limite_quantidade, contas: (ex.resumo && ex.resumo.contas) || [] },
      execucao: (exe.size > 0 || movs.size > 0 || execRodando) ? { estado: execRodando ? 'em_andamento' : 'concluida', ...e, total: c.simulado } : null,
      andamento: job ? { ...job, empresa_id: undefined } : null }
  }

  // Relatório paginado (por SKU): resultado da simulação + situação da execução
  async function itensDaExecucao(empresaId, id, { pagina = 1, porPagina = 100, situacao = 'todos' } = {}) {
    if (!ehUuid(id)) throw erroHttp('Informe a simulação.', 400)
    const ex = await q(sb.from('estoque_ajuste_massa_execucoes').select('id, itens').eq('id', id).eq('empresa_id', empresaId).maybeSingle(), 'simulação')
    if (!ex) throw erroHttp('Simulação não encontrada.', 404)
    const { sim, exe, movs } = await situacaoPorSku(empresaId, ex)
    const MAPA = { simulado: 'apto', igual: 'igual', bloqueado: 'bloqueado', falha: 'falha' }
    let lista = (ex.itens || []).map((sku) => {
      const ev = sim.get(sku)
      if (!ev) return { sku, situacao: 'nao_processado', motivo: 'ainda não simulado', anuncios: [] }
      const d = ev.detalhe || {}
      return { sku, nome: d.nome || null, situacao: MAPA[ev.resultado], motivo: ev.motivo, tmp10_antes: ev.estoque_anterior, numero_lido: ev.numero_lido, novo: ev.estoque_novo,
        diferenca: d.diferenca ?? null, contas_origem: d.contas_origem || [], anuncio_origem: ev.anuncio_id, anuncios: d.anuncios || [], pedidos: d.pedidos || [], avisos: d.avisos || [],
        fila: d.fila || [], execucao: situacaoExecucao(sku, ev, exe.get(sku), movs, id) }
    })
    if (situacao && situacao !== 'todos') lista = lista.filter((i) => i.situacao === situacao || (i.execucao && i.execucao.situacao === situacao))
    const pp = Math.max(1, Math.min(Number(porPagina) || 100, 100000)); const pg = Math.max(1, Number(pagina) || 1)
    return { total: lista.length, pagina: pg, por_pagina: pp, paginas: Math.max(1, Math.ceil(lista.length / pp)), itens: lista.slice((pg - 1) * pp, pg * pp) }
  }

  // ── Lista para a tela (só banco; NÃO decide nada) — UMA linha por SKU, com todos os anúncios das duas plataformas ──
  async function itens({ empresaId, contaRef, contasRef }) {
    const contas = await todasContas(empresaId)
    const resposta = { contas: contas.map((c) => ({ conta_ref: refDe(c), nome: c.nickname, plataforma: c.platform === 'shopee' ? 'shopee' : 'mercadolivre' })),
      contas_selecionadas: [], itens: [], limite_quantidade: limiteQuantidade }
    const desde = new Date(agora().getTime() - JANELA_DIAS * 86400000).toISOString()
    const semBaixa = await q(sb.from('estoque_movimentos').select('sku, referencia, criado_em').eq('empresa_id', empresaId).in('origem', ['venda_mercadolivre', 'venda_shopee'])
      .eq('aplicado', false).gte('criado_em', desde).order('criado_em', { ascending: false }).limit(500), 'vendas sem baixa')
    const porSku = new Map()
    for (const m of (semBaixa || [])) { const x = porSku.get(m.sku) || { sku: m.sku, pedidos: 0, ultima: m.criado_em, canal: String(m.referencia || '').split(':')[1] || null }; x.pedidos++; porSku.set(m.sku, x) }
    resposta.vendas_sem_baixa = [...porSku.values()]
    const refs = new Set(refsDe(contaRef, contasRef))
    const sel = contas.filter((c) => refs.has(refDe(c)))
    resposta.contas_selecionadas = sel.map((c) => ({ conta_ref: refDe(c), nome: c.nickname }))
    if (!sel.length) { resposta.total = 0; resposta.selecionaveis = 0; return resposta }
    const linksML = await lerTodos(() => sb.from('product_ml_links').select('sku, ml_item_id, ml_user_id, account_nickname').eq('empresa_id', empresaId), 'vínculos ML')
    const linksSh = await lerTodos(() => sb.from('product_shopee_links').select('sku, shop_id, item_id, model_id').eq('empresa_id', empresaId), 'vínculos Shopee')
    const anuncios = new Map()
    const g = await grupos.carregar(empresaId)   // anúncio agrupado aparece na linha do PRODUTO PRINCIPAL (com o SKU original)
    const add = (sku, a) => { if (!anuncios.has(sku)) anuncios.set(sku, []); anuncios.get(sku).push(a) }
    for (const l of linksML) if (l.ml_item_id) { const c = contaDoLink(contas, l); add(g.skuEfetivo('mercadolivre', String(l.ml_item_id), '', l.sku), { plataforma: 'mercadolivre', anuncio_id: String(l.ml_item_id), conta: c ? c.nickname : l.account_nickname, conta_ref: c ? refDe(c) : null, sku_original: l.sku }) }
    for (const l of linksSh) { const c = lojaDoLink(contas, l); add(g.skuEfetivo('shopee', String(l.item_id), l.model_id ? String(l.model_id) : '', l.sku), { plataforma: 'shopee', anuncio_id: String(l.item_id) + (l.model_id ? '/' + l.model_id : ''), conta: c ? c.nickname : `loja ${l.shop_id}`, conta_ref: c ? refDe(c) : null, sku_original: l.sku }) }
    const skus = [...anuncios.keys()].filter((sku) => anuncios.get(sku).some((a) => a.conta_ref && refs.has(a.conta_ref))).sort()
    const prods = new Map()
    for (const lote of pedacos(skus, 300)) for (const p of (await q(sb.from('products').select('sku, name, estoque_atual').eq('empresa_id', empresaId).in('sku', lote), 'produtos')) || []) prods.set(p.sku, prods.has(p.sku) ? { ...p, duplicado: true } : p)
    const div = await lerTodos(() => sb.from('estoque_divergencias').select('sku, plataforma, anuncio_id, variacao_id, estoque_ml, atualizado_em').eq('empresa_id', empresaId).not('chave', 'is', null).not('resolvido', 'is', true), 'divergências')
    const divPor = new Map(div.map((d) => [`${d.sku}|${d.anuncio_id}${d.variacao_id ? '/' + d.variacao_id : ''}`, d]))
    resposta.itens = skus.map((sku) => {
      const p = prods.get(sku)
      const as = anuncios.get(sku).map((a) => { const d = divPor.get(`${sku}|${a.anuncio_id}`); return { ...a, na_selecao: !!(a.conta_ref && refs.has(a.conta_ref)), ultima_leitura: d ? d.estoque_ml : null, lida_em: d ? d.atualizado_em : null } })
      const motivo_lista = !p ? 'produto não cadastrado no TMP10' : p.duplicado ? 'SKU duplicado no cadastro' : (p.estoque_atual === null || p.estoque_atual === undefined) ? 'produto sem estoque oficial' : null
      return { sku, nome: p ? p.name : null, tmp10: p ? p.estoque_atual : null, anuncios: as, contas: [...new Set(as.filter((a) => a.na_selecao).map((a) => a.conta))], agrupados: g.membros(sku).length,
        com_divergencia: as.some((a) => a.ultima_leitura !== null), selecionavel: !motivo_lista, motivo_lista }
    })
    resposta.total = resposta.itens.length
    resposta.selecionaveis = resposta.itens.filter((i) => i.selecionavel).length
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
  // Pedidos ainda NÃO importados das contas/lojas indicadas (refs 'ml:<id>' / 'sh:<shop>') — SÓ LEITURA. Usado pelo agrupamento.
  async function pedidosPendentes(empresaId, refs) {
    const set = new Set(refs)
    const contas = (await todasContas(empresaId)).filter((c) => set.has(refDe(c)))
    const ctx = novoContexto(empresaId)
    await atualizarPedidos(ctx, contas)
    return { naoImportados: [...ctx.naoImportados.values()], erroConta: Object.fromEntries(ctx.erroConta) }
  }
  return { simular, iniciarSimulacao, retomarSimulacao, executar, iniciarExecucao, status, itensDaExecucao, itens, diagnosticoML, avaliar: avaliarCompleto, filtrar, pedidosPendentes }
}

module.exports = { criarAjusteMassa, LIMITE_QUANTIDADE_PADRAO, LOTE_SIMULACAO, LOTE_EXECUCAO, AVISO_FIXO }
