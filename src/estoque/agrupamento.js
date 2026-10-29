// Estoque Central — AGRUPAR ANÚNCIOS POR PRODUTO PRINCIPAL (operação administrativa, decisão MANUAL).
//
// O sistema NUNCA agrupa sozinho (nem por nome, imagem, SKU parecido...). O administrador escolhe o produto principal e
// marca os anúncios que conferiu serem a MESMA peça física. Aqui só se: lista o catálogo de anúncios (vínculos que o TMP10
// já importou), lê ao vivo (só leitura) título/imagem/variações, monta a PRÉVIA com bloqueios e alertas e grava pela
// função atômica do banco (migração 26) depois do "CONFIRMAR AGRUPAMENTO".
//
// NADA DE ESTOQUE MUDA AQUI: não soma, não zera, não copia saldo, não põe nada na fila, não envia nada.
//
// BLOQUEIA (não deixa confirmar) quando:
//   • principal: não cadastrado / duplicado / sem estoque oficial · já agrupado em outro principal · está no PILOTO
//     (anúncios novos passariam a receber envio real sem decisão sua)
//   • anúncio: não encontrado no catálogo · conta/loja não conectada · já está em OUTRO agrupamento · vínculo ligado a mais
//     de um SKU · vínculo ML com variação / anúncio ML com variações (decisão: fora desta versão) · item Shopee com
//     variações vinculado sem model_id · item Shopee sem variação ligado também a outros SKUs · SKU declarado no anúncio
//     (ao vivo) diferente do SKU original do vínculo · leitura ao vivo falhou
//   • SKU original: é produto principal de outro grupo (não encadeia) · tem anúncios que ficariam FORA do grupo (tudo ou
//     nada: um SKU original nunca fica dividido entre dois produtos)
//   • variações diferentes do mesmo item Shopee no mesmo produto (inclusive contra os anúncios do próprio principal)
//   • pedidos ainda NÃO importados dos anúncios que entram ou saem · falha ao consultar os pedidos · divergência NÃO
//     resolvida dos SKUs que entram
//   • desfazer/remover: remover só parte dos anúncios de um SKU original
//   • anúncio FULL do ML (inventory_id) cujo saldo Full NÃO pôde ser consultado agora (sem confirmar o Full, não agrupa)
// ALERTA (mostra, você decide): saldo do SKU original que fica CONGELADO (não é somado) · vendas sem baixa (pendências) ·
//   Full/FBS (o saldo Full fica NO ANÚNCIO: não é somado ao principal nem aos outros anúncios) · reserva de promoção · sincronização desligada · modo ATIVO (o estoque do principal irá aos anúncios na
//   próxima movimentação). Em PILOTO, anúncio agrupado NUNCA recebe envio real (servico.decidirEnvio).
const crypto = require('crypto')
const ROT = { mercadolivre: 'ML', shopee: 'Shopee' }
const erroHttp = (msg, status, extra = {}) => Object.assign(new Error(msg), { status, ...extra })
const ehUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''))
const chaveDe = (a) => `${a.plataforma}|${a.conta_ref}|${a.anuncio_id}|${a.variacao_id || ''}`
const JANELA_DIAS = 30

function criarAgrupamento({ sb, ml, shopee, grupos, q, rpc, lerConfig, ajusteMassa, full = null, log = console.log, agora = () => new Date(), dormir = () => Promise.resolve() }) {
  async function lerTodos(montar, contexto) {
    const todos = []
    for (let de = 0; ; de += 1000) {
      const lote = await q(montar().range(de, de + 999), contexto)
      todos.push(...(lote || []))
      if (!lote || lote.length < 1000) return todos
    }
  }
  const pedacos = (l, n) => { const r = []; for (let i = 0; i < l.length; i += n) r.push(l.slice(i, i + n)); return r }
  async function contasDaEmpresa(empresaId) {
    return (await q(sb.from('ml_accounts').select('id, nickname, ml_user_id, platform, active, empresa_id, access_token, refresh_token, expires_at').eq('empresa_id', empresaId), 'contas')) || []
  }
  async function produtosMap(empresaId, skus = null) {
    const lista = skus ? await (async () => { const r = []; for (const l of pedacos([...new Set(skus)], 300)) r.push(...((await q(sb.from('products').select('id, sku, name, estoque_atual, photo').eq('empresa_id', empresaId).in('sku', l), 'produtos')) || [])); return r })()
      : await lerTodos(() => sb.from('products').select('id, sku, name, estoque_atual, photo').eq('empresa_id', empresaId), 'produtos')
    const m = new Map()
    for (const p of lista) m.set(p.sku, m.has(p.sku) ? { ...m.get(p.sku), duplicado: true } : p)
    return m
  }

  // ── Catálogo: TODOS os anúncios que o TMP10 conhece (vínculos), de todas as contas e lojas ─────────────────────────
  async function catalogo(empresaId, g, contas) {
    const linksML = await lerTodos(() => sb.from('product_ml_links').select('sku, account_nickname, ml_item_id, ml_user_id, sincronizar, ml_variation_id').eq('empresa_id', empresaId), 'vínculos ML')
    const linksSh = await lerTodos(() => sb.from('product_shopee_links').select('sku, shop_id, item_id, model_id, sincronizar').eq('empresa_id', empresaId), 'vínculos Shopee')
    const porChave = new Map()
    const skusDoAnuncio = new Map()   // plataforma|anuncio|variacao → Set(sku) (vínculo ambíguo)
    const doItemSh = new Map()        // item Shopee → [vínculos]
    const marcar = (k, sku) => { if (!skusDoAnuncio.has(k)) skusDoAnuncio.set(k, new Set()); skusDoAnuncio.get(k).add(sku) }
    for (const l of linksML) {
      if (!l.ml_item_id) continue
      const c = contas.filter((x) => x.platform !== 'shopee' && (l.ml_user_id ? String(x.ml_user_id) === String(l.ml_user_id) : x.nickname === l.account_nickname))
      const a = { plataforma: 'mercadolivre', conta_ref: l.ml_user_id ? String(l.ml_user_id) : `nick:${l.account_nickname}`, conta_nome: c.length === 1 ? c[0].nickname : l.account_nickname,
        conta_conectada: c.length === 1 && c[0].active === true, anuncio_id: String(l.ml_item_id), variacao_id: '', sku_original: l.sku, sincronizar: l.sincronizar,
        ml_variation_id: l.ml_variation_id || null, _conta: c.length === 1 ? c[0] : null }
      a.chave = chaveDe(a)
      marcar(`mercadolivre|${a.anuncio_id}|`, l.sku)
      if (porChave.has(a.chave)) { porChave.get(a.chave).outros_skus = [...new Set([...(porChave.get(a.chave).outros_skus || []), l.sku])]; continue }
      porChave.set(a.chave, a)
    }
    for (const l of linksSh) {
      if (!l.item_id || !l.shop_id) continue
      const c = contas.filter((x) => x.platform === 'shopee' && String(x.ml_user_id) === String(l.shop_id))
      const a = { plataforma: 'shopee', conta_ref: String(l.shop_id), conta_nome: c.length === 1 ? c[0].nickname : `loja ${l.shop_id}`, conta_conectada: c.length === 1 && c[0].active === true,
        anuncio_id: String(l.item_id), variacao_id: l.model_id ? String(l.model_id) : '', sku_original: l.sku, sincronizar: l.sincronizar, _conta: c.length === 1 ? c[0] : null }
      a.chave = chaveDe(a)
      marcar(`shopee|${a.anuncio_id}|${a.variacao_id}`, l.sku)
      const k = `${l.shop_id}|${l.item_id}`; if (!doItemSh.has(k)) doItemSh.set(k, []); doItemSh.get(k).push(a)
      if (porChave.has(a.chave)) { porChave.get(a.chave).outros_skus = [...new Set([...(porChave.get(a.chave).outros_skus || []), l.sku])]; continue }
      porChave.set(a.chave, a)
    }
    for (const a of porChave.values()) {
      const skus = skusDoAnuncio.get(`${a.plataforma}|${a.anuncio_id}|${a.variacao_id}`) || new Set([a.sku_original])
      a.ambiguo = skus.size > 1 ? [...skus].sort() : null
      if (a.plataforma === 'shopee') {
        const doItem = doItemSh.get(`${a.conta_ref}|${a.anuncio_id}`) || []
        a.item_misto = !a.variacao_id && doItem.some((o) => o.sku_original !== a.sku_original) ? [...new Set(doItem.map((o) => o.sku_original))].sort() : null
      }
      const gr = g.doAnuncio(a.plataforma, a.anuncio_id, a.variacao_id)
      a.grupo = gr ? { id: gr.id, produto_sku: gr.produto_sku } : null
    }
    return porChave
  }
  const publico = (a) => { const { _conta, ...resto } = a; return resto }

  // ── Leitura AO VIVO (só GET) de até 50 anúncios: título, imagem, quantidade, variações, SKU declarado ────────────
  async function lerAoVivo(lista) {
    const res = new Map()
    const ml1 = new Map(), shSimples = new Map(), shModelos = new Map()
    for (const a of lista) {
      if (!a._conta || !a.conta_conectada) { res.set(a.chave, { erro: 'conta/loja não conectada/ativa nesta empresa' }); continue }
      if (a.plataforma === 'mercadolivre') { if (!ml1.has(a._conta.id)) ml1.set(a._conta.id, { conta: a._conta, itens: [] }); ml1.get(a._conta.id).itens.push(a) }
      else if (a.variacao_id) { const k = `${a._conta.id}|${a.anuncio_id}`; if (!shModelos.has(k)) shModelos.set(k, { conta: a._conta, item: a.anuncio_id, itens: [] }); shModelos.get(k).itens.push(a) }
      else { if (!shSimples.has(a._conta.id)) shSimples.set(a._conta.id, { conta: a._conta, itens: [] }); shSimples.get(a._conta.id).itens.push(a) }
    }
    for (const { conta, itens } of ml1.values()) for (const lote of pedacos(itens, 20)) {
      let mapa = null, erro = null
      try { mapa = await ml.lerAnuncios(conta, [...new Set(lote.map((a) => a.anuncio_id))]) } catch (e) { erro = e.message }
      for (const a of lote) {
        const l = mapa ? mapa.get(a.anuncio_id) : null
        res.set(a.chave, !l ? { erro: erro || 'anúncio não devolvido pelo ML' } : l.erro ? { erro: l.erro }
          : { titulo: l.titulo ?? null, imagem: l.imagem ?? null, quantidade: l.quantidade, variacoes: l.variacoes || 0, sku_declarado: l.sku_declarado || a.anuncio_id, inventory_id: l.inventory_id || null })
      }
      await dormir()
    }
    const infoItens = new Map()   // nome/imagem/sku/has_model do item Shopee
    const lerInfo = async (conta, ids) => {
      for (const lote of pedacos(ids.filter((i) => !infoItens.has(`${conta.id}|${i}`)), 20)) {
        let mapa = null, erro = null
        try { mapa = await shopee.lerItens(conta, lote) } catch (e) { erro = e.message }
        for (const i of lote) infoItens.set(`${conta.id}|${i}`, mapa ? (mapa.get(i) || { erro: 'item não devolvido pela Shopee' }) : { erro })
        await dormir()
      }
    }
    for (const { conta, itens } of shSimples.values()) await lerInfo(conta, [...new Set(itens.map((a) => a.anuncio_id))])
    for (const { conta, item } of shModelos.values()) await lerInfo(conta, [item])
    const dadosItem = (b) => ({ titulo: b.item_name ?? null, imagem: b.image && Array.isArray(b.image.image_url_list) ? b.image.image_url_list[0] || null : null })
    const soma = (l) => (Array.isArray(l) ? l.reduce((t, x) => t + (Number(x && x.stock) || 0), 0) : null)
    for (const { conta, itens } of shSimples.values()) for (const a of itens) {
      const v = infoItens.get(`${conta.id}|${a.anuncio_id}`)
      if (!v || v.erro || v.quantidade === null || v.quantidade === undefined) { res.set(a.chave, { erro: (v && v.erro) || 'sem quantidade' }); continue }
      const b = v.bruto || {}; const si = b.stock_info_v2 || {}
      res.set(a.chave, { ...dadosItem(b), quantidade: v.quantidade, reserva: v.reservada ?? null, tem_variacao: !!v.tem_variacao, estoque_shopee: soma(si.shopee_stock),
        sku_declarado: String(b.item_sku || a.anuncio_id).trim() })
    }
    for (const { conta, item, itens } of shModelos.values()) {
      let mapa = null, erro = null
      try { mapa = await shopee.lerModelos(conta, item) } catch (e) { erro = e.message }
      const info = infoItens.get(`${conta.id}|${item}`) || {}
      for (const a of itens) {
        const v = mapa ? mapa.get(a.variacao_id) : null
        if (!v || v.quantidade === null || v.quantidade === undefined) { res.set(a.chave, { erro: erro || 'variação não devolvida pela Shopee' }); continue }
        const b = v.bruto || {}; const si = b.stock_info_v2 || {}
        res.set(a.chave, { ...dadosItem(info.bruto || {}), imagem: v.imagem || dadosItem(info.bruto || {}).imagem, variacao_nome: v.nome || null, quantidade: v.quantidade, reserva: v.reservada ?? null,
          estoque_shopee: soma(si.shopee_stock), sku_declarado: String(b.model_sku || `${a.anuncio_id}-${a.variacao_id}`).trim() })
      }
      await dormir()
    }
    return res
  }

  // ── Telas: produtos, anúncios, consulta ao vivo, grupos ────────────────────────────────────────────────────────────
  async function produtos({ empresaId, busca = '', limite = 50 }) {
    const g = await grupos.carregar(empresaId)
    const qb = String(busca || '').trim().toLowerCase()
    const prods = [...(await produtosMap(empresaId)).values()]
    const achados = prods.filter((p) => !qb || String(p.sku).toLowerCase().includes(qb) || String(p.name || '').toLowerCase().includes(qb))
      .sort((a, b) => String(a.sku).localeCompare(String(b.sku)))
    return { total: achados.length, produtos: achados.slice(0, Math.min(Number(limite) || 50, 200)).map((p) => ({ sku: p.sku, nome: p.name, estoque: p.estoque_atual, foto: p.photo || null,
      duplicado: !!p.duplicado, agrupado_em: g.principalDe(p.sku), anuncios_agrupados: g.membros(p.sku).length })) }
  }

  async function anuncios({ empresaId, plataforma = '', conta = '', busca = '', principal = '', pagina = 1, porPagina = 100 }) {
    const g = await grupos.carregar(empresaId)
    const contas = await contasDaEmpresa(empresaId)
    const cat = await catalogo(empresaId, g, contas)
    const prods = await produtosMap(empresaId, [...new Set([...cat.values()].map((a) => a.sku_original))])
    const qb = String(busca || '').trim().toLowerCase()
    let lista = [...cat.values()].map((a) => { const p = prods.get(a.sku_original); return { ...publico(a), produto_original: p ? { nome: p.name, estoque: p.estoque_atual, foto: p.photo || null } : null } })
    lista = lista.filter((a) => (!plataforma || a.plataforma === plataforma) && (!conta || a.conta_ref === conta)
      && (!qb || a.sku_original.toLowerCase().includes(qb) || a.anuncio_id.toLowerCase().includes(qb) || String((a.produto_original && a.produto_original.nome) || '').toLowerCase().includes(qb)))
    lista.sort((a, b) => a.sku_original.localeCompare(b.sku_original) || a.chave.localeCompare(b.chave))
    if (principal) for (const a of lista) a.do_principal = a.sku_original === principal
    const pp = Math.max(1, Math.min(Number(porPagina) || 100, 500)); const pg = Math.max(1, Number(pagina) || 1)
    const contasTela = contas.filter((c) => c.active === true).map((c) => ({ conta_ref: String(c.ml_user_id), nome: c.nickname, plataforma: c.platform === 'shopee' ? 'shopee' : 'mercadolivre' }))
    return { total: lista.length, pagina: pg, paginas: Math.max(1, Math.ceil(lista.length / pp)), contas: contasTela, anuncios: lista.slice((pg - 1) * pp, pg * pp) }
  }

  async function aoVivo({ empresaId, chaves }) {
    const ks = [...new Set((Array.isArray(chaves) ? chaves : []).map(String))]
    if (!ks.length) throw erroHttp('Escolha ao menos um anúncio.', 400)
    if (ks.length > 50) throw erroHttp('No máximo 50 anúncios por consulta ao vivo.', 400)
    const g = await grupos.carregar(empresaId)
    const cat = await catalogo(empresaId, g, await contasDaEmpresa(empresaId))
    const lista = ks.map((k) => cat.get(k)).filter(Boolean)
    const lidos = await lerAoVivo(lista)
    return { consultado_em: agora().toISOString(), anuncios: ks.map((k) => (cat.has(k) ? { chave: k, ...(lidos.get(k) || {}) } : { chave: k, erro: 'anúncio não encontrado no catálogo do TMP10' })),
      observacao: 'Somente leitura. Nada foi gravado, somado ou enviado.' }
  }

  async function listarGrupos({ empresaId }) {
    const g = await grupos.carregar(empresaId)
    const principais = [...new Set(g.linhas.map((l) => l.produto_sku))].sort()
    const prods = await produtosMap(empresaId, principais)
    return { grupos: principais.map((sku) => { const ms = g.membros(sku); const p = prods.get(sku)
      return { produto_sku: sku, nome: p ? p.name : null, estoque: p ? p.estoque_atual : null, foto: p ? p.photo || null : null, anuncios_agrupados: ms.length,
        skus_originais: [...new Set(ms.map((m) => m.sku_original))].sort(), plataformas: [...new Set(ms.map((m) => m.plataforma))], contas: [...new Set(ms.map((m) => `${ROT[m.plataforma]} ${m.conta_nome || m.conta_ref}`))] } }) }
  }

  async function detalheGrupo({ empresaId, produtoSku }) {
    const sku = String(produtoSku || '').trim(); if (!sku) throw erroHttp('Informe o produto principal.', 400)
    const g = await grupos.carregar(empresaId)
    const ms = g.membros(sku)
    const prods = await produtosMap(empresaId, [sku, ...ms.map((m) => m.sku_original)])
    const p = prods.get(sku)
    const eventos = (await q(sb.from('estoque_agrupamento_eventos').select('operacao_id, acao, usuario_id, adicionados, removidos, detalhe, criado_em').eq('empresa_id', empresaId).eq('produto_sku', sku).order('criado_em', { ascending: false }).limit(50), 'histórico')) || []
    const usuarios = [...new Set(eventos.map((e) => e.usuario_id).filter(Boolean))]
    const nomes = usuarios.length ? new Map(((await q(sb.from('users').select('id, name').eq('empresa_id', empresaId).in('id', usuarios), 'usuários')) || []).map((u) => [u.id, u.name])) : new Map()
    return { produto: p ? { sku, nome: p.name, estoque: p.estoque_atual, foto: p.photo || null } : { sku, nome: null, estoque: null }, agrupado_em: g.principalDe(sku),
      anuncios: ms.map((m) => { const o = prods.get(m.sku_original); return { id: m.id, chave: chaveDe(m), plataforma: m.plataforma, conta_ref: m.conta_ref, conta_nome: m.conta_nome, anuncio_id: m.anuncio_id,
        variacao_id: m.variacao_id, sku_original: m.sku_original, agrupado_em: m.criado_em, saldo_congelado_original: o ? o.estoque_atual : null } }),
      historico: eventos.map((e) => ({ ...e, usuario: nomes.get(e.usuario_id) || null })) }
  }

  // ── PRÉVIA (não grava nada) ──────────────────────────────────────────────────────────────────────────────────────
  async function previa({ empresaId, produtoSku, adicionar = [], remover = [] }) {
    const sku = String(produtoSku || '').trim()
    if (!sku) throw erroHttp('Escolha o produto principal.', 400)
    const add = [...new Set((Array.isArray(adicionar) ? adicionar : []).map(String))]
    const rem = [...new Set((Array.isArray(remover) ? remover : []).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0))]
    if (add.length > 500 || rem.length > 500) throw erroHttp('No máximo 500 anúncios por operação.', 400)
    const g = await grupos.carregar(empresaId)
    const contas = await contasDaEmpresa(empresaId)
    const cat = await catalogo(empresaId, g, contas)
    const cfg = await lerConfig(empresaId)
    const bloqueios = [], alertas = []
    const bloq = (motivo, chave = null) => bloqueios.push({ chave, motivo })
    const alerta = (motivo, chave = null) => alertas.push({ chave, motivo })
    const nome = (a) => `${ROT[a.plataforma]} ${a.conta_nome || a.conta_ref} ${a.anuncio_id}${a.variacao_id ? '/' + a.variacao_id : ''}`

    // principal
    const membrosAtuais = g.membros(sku)
    const todosSkus = new Set([sku, ...membrosAtuais.map((m) => m.sku_original), ...add.map((k) => (cat.get(k) || {}).sku_original).filter(Boolean)])
    const prods = await produtosMap(empresaId, [...todosSkus])
    const p = prods.get(sku)
    if (!p) bloq(`o produto principal ${sku} não está cadastrado no TMP10`)
    else if (p.duplicado) bloq(`há mais de um produto com o SKU ${sku} no cadastro — corrija antes de agrupar`)
    else if (p.estoque_atual === null || p.estoque_atual === undefined) bloq(`o produto principal ${sku} não tem estoque oficial definido`)
    const absorvido = g.principalDe(sku)
    if (absorvido) bloq(`${sku} já está agrupado no produto principal ${absorvido} — escolha ${absorvido} como principal (agrupamentos não se encadeiam)`)
    if (add.length && cfg.modo === 'piloto' && (cfg.skus_piloto || []).includes(sku)) bloq(`${sku} está na lista do PILOTO (envio real). Anúncios novos passariam a receber envio real sem a sua decisão — tire ${sku} do piloto, agrupe, confira e decida depois`)

    // remover (desfazer/editar)
    const idsAtuais = new Map(membrosAtuais.map((m) => [m.id, m]))
    const removidos = []
    for (const id of rem) { const m = idsAtuais.get(id); if (!m) bloq(`o anúncio #${id} não está (mais) agrupado em ${sku} — atualize a tela`); else removidos.push(m) }
    const ficam = membrosAtuais.filter((m) => !rem.includes(m.id))

    // adicionar
    const novos = []
    for (const k of add) {
      const a = cat.get(k)
      if (!a) { bloq(`anúncio ${k.split('|').slice(2).join('/')} não encontrado entre os vínculos do TMP10 (importe o anúncio primeiro)`, k); continue }
      if (a.grupo && a.grupo.produto_sku === sku && !rem.includes(a.grupo.id)) { alerta(`${nome(a)} já faz parte deste agrupamento — ignorado`, k); continue }
      if (a.grupo && a.grupo.produto_sku !== sku) { bloq(`${nome(a)} já está agrupado em ${a.grupo.produto_sku} — desfaça lá antes`, k); continue }
      if (a.sku_original === sku) { alerta(`${nome(a)} já é um anúncio do próprio ${sku} (mesmo SKU) — não precisa agrupar`, k); continue }
      novos.push(a)
    }
    const finais = [...ficam.map((m) => ({ ...m, chave: chaveDe(m), atual: true })), ...novos]

    for (const a of novos) {
      if (!a.conta_conectada) bloq(`${nome(a)}: conta/loja não conectada ou inativa nesta empresa`, a.chave)
      if (a.ambiguo || a.outros_skus) bloq(`${nome(a)} está vinculado a mais de um SKU (${[...new Set([...(a.ambiguo || []), a.sku_original, ...(a.outros_skus || [])])].join(', ')}) — vínculo ambíguo; corrija o vínculo antes`, a.chave)
      if (a.item_misto) bloq(`${nome(a)}: item Shopee vinculado sem variação, mas o mesmo item também está ligado a ${a.item_misto.filter((s) => s !== a.sku_original).join(', ')} — não dá para saber a peça`, a.chave)
      if (a.ml_variation_id) bloq(`${nome(a)}: vínculo com variação do Mercado Livre — fora desta versão (o pedido do ML não traz a variação)`, a.chave)
      if (g.ehPrincipal(a.sku_original)) bloq(`${a.sku_original} (de ${nome(a)}) é produto principal de outro agrupamento — desfaça aquele antes (agrupamentos não se encadeiam)`, a.chave)
      if (a.sincronizar === false) alerta(`${nome(a)}: sincronização desligada neste vínculo — o anúncio não receberá envio`, a.chave)
    }

    // SKU original: tudo ou nada (nunca fica dividido entre dois produtos)
    const chavesFinais = new Set(finais.map((a) => a.chave))
    // variações DIFERENTES do mesmo item Shopee no mesmo produto (inclui os anúncios do próprio principal): são peças
    // com estoque independente na Shopee (cor/tamanho/kit) — nunca a mesma peça física
    const doPrincipal = [...cat.values()].filter((a) => a.sku_original === sku && a.plataforma === 'shopee')
    const porItemSh = new Map()
    for (const a of [...finais.filter((x) => x.plataforma === 'shopee'), ...doPrincipal]) {
      const k = `${a.conta_ref}|${a.anuncio_id}`; if (!porItemSh.has(k)) porItemSh.set(k, new Set()); porItemSh.get(k).add(a.variacao_id || '')
    }
    for (const [k, vs] of porItemSh) if (vs.size > 1) bloq(`o item Shopee ${k.split('|')[1]} entraria com ${vs.size} variações diferentes (${[...vs].map((v) => v || 'sem variação').join(', ')}) no mesmo produto — cada variação é uma peça diferente (cor/tamanho/kit); escolha só a variação que é este produto`)
    const doSku = new Map()
    for (const a of cat.values()) { if (!doSku.has(a.sku_original)) doSku.set(a.sku_original, []); doSku.get(a.sku_original).push(a) }
    const originaisFinais = [...new Set(finais.map((a) => a.sku_original))]
    for (const x of originaisFinais) {
      const fora = (doSku.get(x) || []).filter((a) => !chavesFinais.has(a.chave))
      if (fora.length) bloq(`o SKU ${x} também tem ${fora.length} anúncio(s) fora deste agrupamento (${fora.slice(0, 5).map(nome).join(' · ')}${fora.length > 5 ? '…' : ''}). Um SKU original não pode ficar dividido: inclua todos ou corrija o SKU nos anúncios`)
    }
    for (const x of new Set(removidos.map((m) => m.sku_original))) {
      const restam = ficam.filter((m) => m.sku_original === x)
      if (restam.length) bloq(`remova juntos todos os anúncios do SKU ${x} (${restam.length} continuariam agrupados) — um SKU original não pode ficar dividido`)
    }

    // leitura AO VIVO dos anúncios que entram (só GET)
    const lidos = novos.length ? await lerAoVivo(novos.filter((a) => a.conta_conectada)) : new Map()
    for (const a of novos) {
      const l = lidos.get(a.chave); if (!l) continue
      a.ao_vivo = l
      if (l.erro) { bloq(`${nome(a)}: não foi possível ler agora (${l.erro}) — sem conferir, não agrupa`, a.chave); continue }
      if (a.plataforma === 'mercadolivre' && l.variacoes > 0) bloq(`${nome(a)} tem ${l.variacoes} variação(ões) no Mercado Livre — fora desta versão`, a.chave)
      if (a.plataforma === 'shopee' && !a.variacao_id && l.tem_variacao) bloq(`${nome(a)}: o item tem variações na Shopee, mas o vínculo está sem model_id — vincule a variação certa`, a.chave)
      if (l.sku_declarado !== a.sku_original) bloq(`${nome(a)} declara hoje o SKU "${l.sku_declarado}", diferente do vínculo "${a.sku_original}" — os pedidos chegariam com outro SKU; corrija o vínculo/anúncio antes`, a.chave)
      if (l.reserva > 0) alerta(`${nome(a)}: ${l.reserva} unidade(s) reservada(s) para promoção na Shopee — a fila nunca envia menos que a reserva`, a.chave)
      if (l.estoque_shopee > 0) alerta(`${nome(a)}: há estoque no armazém da Shopee (FBS) — esse anúncio não recebe envio do TMP10`, a.chave)
    }

    // Full/FBS (histórico de vendas — função estoque_anuncios_full, migração 22)
    if (novos.length) {
      try {
        const vendasFull = new Set(((await rpc('estoque_anuncios_full', { p_empresa: empresaId, p_dias: 90 })) || []).map((x) => String(typeof x === 'object' && x !== null ? Object.values(x)[0] : x)))
        for (const a of novos) if (vendasFull.has(a.anuncio_id)) alerta(`${nome(a)}: anúncio com vendas Full/FBS — não recebe envio; vendas Full não baixam o TMP10`, a.chave)
      } catch (e) {
        const semFuncao = /estoque_anuncios_full/.test(e.message) && /(Could not find|does not exist|PGRST202)/i.test(e.message)
        alerta(semFuncao ? 'a conferência de vendas Full/FBS pelo histórico não rodou: a função estoque_anuncios_full não existe no banco (migração 22 ainda não aplicada). O saldo Full do ML é conferido abaixo pela API, à parte'
          : `não foi possível conferir vendas Full/FBS pelo histórico agora (${e.message})`)
      }
    }
    // Full do ML pela API (inventory_id + /inventories/{id}/stock/fulfillment) — SÓ LEITURA. O saldo Full fica NO ANÚNCIO.
    const novosML = novos.filter((a) => a.plataforma === 'mercadolivre' && a.ao_vivo && !a.ao_vivo.erro && !(a.ao_vivo.variacoes > 0))
    if (full && novosML.length) {
      const lidosFull = await full.lerAoVivo(novosML)
      for (const a of novosML) {
        const f = lidosFull.get(a.chave); if (!f) continue
        a.full = f
        if (f.situacao === 'atualizado') alerta(`${nome(a)}: anúncio FULL — ${f.disponivel} unidade(s) disponível(is) no armazém do ML (total ${f.total}). Esse saldo fica NO ANÚNCIO: NÃO é somado ao ${sku} nem aos outros anúncios, o TMP10 não envia estoque para ele e vendas Full não baixam o ${sku}`, a.chave)
        else if (f.situacao === 'erro' && f.inventory_id) bloq(`${nome(a)}: anúncio FULL (inventory_id ${f.inventory_id}), mas a consulta do saldo Full falhou (${f.erro}) — sem confirmar o Full, não agrupa. Tente de novo em instantes`, a.chave)
        else if (f.situacao === 'erro') bloq(`${nome(a)}: não foi possível confirmar se o anúncio é Full (${f.erro}) — sem conferir, não agrupa`, a.chave)
        else if (f.situacao === 'indisponivel') alerta(`${nome(a)}: anúncio com inventory_id ${f.inventory_id || '—'}, mas o ML não informa o saldo Full (${f.erro}). Saldo Full "Indisponível para consulta" — NÃO é tratado como zero; o TMP10 não envia estoque para anúncio com inventory_id`, a.chave)
      }
    }

    // saldos que ficam CONGELADOS (não são somados), vendas sem baixa e divergências abertas dos SKUs originais
    const originaisNovos = [...new Set(novos.map((a) => a.sku_original))]
    for (const x of originaisNovos) {
      const o = prods.get(x)
      if (o && o.duplicado) alerta(`há mais de um produto com o SKU ${x} no cadastro (o saldo dele fica congelado)`)
      else if (o && o.estoque_atual !== null && o.estoque_atual !== undefined && Number(o.estoque_atual) !== 0) alerta(`o produto ${x} tem ${o.estoque_atual} unidade(s) registradas. Esse saldo fica CONGELADO e NÃO é somado ao ${sku} (${p ? p.estoque_atual : '—'}). Se essas peças existem fisicamente e não estão contadas no ${sku}, ajuste o ${sku} manualmente depois`)
    }
    const desde = new Date(agora().getTime() - JANELA_DIAS * 86400000).toISOString()
    const envolvidos = [...new Set([...originaisNovos, ...removidos.map((m) => m.sku_original)])]
    if (envolvidos.length) {
      const sem = (await q(sb.from('estoque_movimentos').select('sku, referencia, observacao').eq('empresa_id', empresaId).eq('aplicado', false).in('origem', ['venda_mercadolivre', 'venda_shopee']).in('sku', envolvidos).gte('criado_em', desde).limit(200), 'vendas sem baixa')) || []
      for (const x of envolvidos) { const n = sem.filter((m) => m.sku === x).length; if (n) alerta(`o SKU ${x} tem ${n} venda(s) SEM baixa nos últimos ${JANELA_DIAS} dias (pendências) — confira o estoque do ${sku} depois`) }
      const div = (await q(sb.from('estoque_divergencias').select('sku, anuncio_id').eq('empresa_id', empresaId).not('chave', 'is', null).not('resolvido', 'is', true).in('sku', envolvidos).limit(200), 'divergências')) || []
      for (const x of envolvidos) {
        const n = div.filter((d) => d.sku === x).length
        if (!n) continue
        // divergência NÃO resolvida nos anúncios que ENTRAM: bloqueia (o número da plataforma ainda não foi decidido)
        if (originaisNovos.includes(x)) bloq(`o SKU ${x} tem ${n} divergência(s) NÃO resolvida(s) (TMP10 × plataforma) — resolva no painel do Estoque (aceitar, enviar o número do TMP10 ou ignorar) antes de agrupar`)
        else alerta(`o SKU ${x} tem ${n} divergência(s) aberta(s) — depois, use "Conferir de novo"`)
      }
    }

    // pedidos ainda NÃO importados dos anúncios envolvidos (só leitura nas plataformas)
    const envolvidosAn = [...novos, ...removidos]
    if (envolvidosAn.length && ajusteMassa && ajusteMassa.pedidosPendentes) {
      const refs = [...new Set(envolvidosAn.map((a) => (a.plataforma === 'shopee' ? 'sh:' : 'ml:') + String(a.conta_ref).replace(/^nick:.*/, '')).filter((r) => !/:$/.test(r)))]
      let pend = null
      try { pend = await ajusteMassa.pedidosPendentes(empresaId, refs) } catch (e) { pend = { naoImportados: [], erroConta: { geral: e.message } } }
      const afetados = (lista) => {
        const ids = new Set(lista.map((a) => `${a.plataforma}|${a.anuncio_id}`)); const skus = new Set(lista.map((a) => a.sku_original))
        return pend.naoImportados.filter((pd) => !(pd.plataforma === 'shopee' && pd.fbs) && (pd.itens || []).some((it) => skus.has(it.sku) || ids.has(`${pd.plataforma}|${String(it.anuncio || it.item_id || '')}`)))
      }
      const errosConta = Object.values(pend.erroConta || {})
      if (removidos.length) {
        const pr = afetados(removidos)
        if (pr.length) bloq(`há ${pr.length} pedido(s) ainda NÃO importado(s) desses anúncios (${pr.slice(0, 5).map((x) => `${ROT[x.plataforma]} ${x.id || x.sn}`).join(', ')}). Desfazer agora faria a baixa cair no produto antigo — aguarde a importação`)
        if (errosConta.length) bloq(`não foi possível confirmar os pedidos (${errosConta.join(' · ')}) — sem essa conferência não dá para desfazer com segurança`)
      }
      if (novos.length) {
        const pn = afetados(novos)
        if (pn.length) bloq(`há ${pn.length} pedido(s) ainda NÃO importado(s) desses anúncios (${pn.slice(0, 5).map((x) => `${ROT[x.plataforma]} ${x.id || x.sn}`).join(', ')}) — aguarde a importação dos pedidos antes de agrupar (a baixa ficaria ambígua)`)
        if (errosConta.length && !removidos.length) bloq(`não foi possível confirmar os pedidos (${errosConta.join(' · ')}) — sem essa conferência não dá para agrupar com segurança`)
      }
    }
    if (novos.length && cfg.modo === 'piloto') alerta(`modo PILOTO: os anúncios agrupados ficam SEMPRE em simulação — mesmo que ${sku} entre na lista do piloto, só os anúncios com o próprio SKU ${sku} recebem envio real`)
    if (novos.length && cfg.modo === 'ativo') alerta(`modo ATIVO: na próxima movimentação de ${sku} (ou no "Sincronizar Estoque Agora"), o estoque de ${sku} será enviado também aos anúncios agrupados. O agrupamento em si não envia nada.`)
    if (novos.length) alerta(`o agrupamento NÃO envia nada agora e NÃO altera saldos. Os anúncios agrupados passam a mostrar o estoque de ${sku} na próxima movimentação dele ou no "Sincronizar Estoque Agora"`)

    const assinatura = crypto.createHash('sha256').update(JSON.stringify([sku, novos.map((a) => a.chave).sort(), removidos.map((m) => m.id).sort(), membrosAtuais.map((m) => m.id).sort()])).digest('hex').slice(0, 32)
    const detalhe = (a) => ({ chave: a.chave, plataforma: a.plataforma, conta_ref: a.conta_ref, conta_nome: a.conta_nome, anuncio_id: a.anuncio_id, variacao_id: a.variacao_id || '',
      sku_original: a.sku_original, saldo_original: prods.get(a.sku_original) ? prods.get(a.sku_original).estoque_atual : null, ao_vivo: a.ao_vivo || null,
      full: a.full ? { situacao: a.full.situacao, inventory_id: a.full.inventory_id || null, disponivel: a.full.disponivel ?? null, total: a.full.total ?? null, consultado_em: a.full.consultado_em || null } : null })
    return {
      principal: { sku, nome: p ? p.name : null, estoque: p ? p.estoque_atual : null, foto: p ? p.photo || null : null },
      adicionar: novos.map(detalhe), remover: removidos.map((m) => ({ id: m.id, ...detalhe({ ...m, chave: chaveDe(m) }) })),
      final: finais.map((a) => ({ chave: a.chave, plataforma: a.plataforma, conta_nome: a.conta_nome, anuncio_id: a.anuncio_id, variacao_id: a.variacao_id || '', sku_original: a.sku_original, novo: !a.atual })),
      quantidade_final: finais.length, bloqueios, alertas, pode_confirmar: bloqueios.length === 0 && (novos.length + removidos.length) > 0, assinatura,
      config: { modo: cfg.modo }
    }
  }

  // ── CONFIRMAR AGRUPAMENTO (grava atômico; nada de estoque muda) ──────────────────────────────────────────────────
  async function confirmar({ empresaId, usuarioId, produtoSku, adicionar = [], remover = [], conferido, assinatura, operacaoId, produtos = [], origem = 'estoque' }) {
    if (conferido !== true) throw erroHttp('Marque "Conferi que todos estes anúncios são exatamente a mesma peça física" antes de confirmar.', 400)
    const pv = await previa({ empresaId, produtoSku, adicionar, remover })
    if (!assinatura || pv.assinatura !== assinatura) throw erroHttp('A seleção ou o agrupamento mudou desde a prévia. Gere a prévia de novo e confira.', 409, { previa: pv })
    if (pv.bloqueios.length) throw erroHttp(`Não é possível confirmar: ${pv.bloqueios.map((b) => b.motivo).join(' | ')}`, 409, { previa: pv })
    if (!pv.adicionar.length && !pv.remover.length) throw erroHttp('Nada a alterar.', 400)
    const acao = pv.adicionar.length && pv.final.length === pv.adicionar.length ? 'agrupar' : (!pv.final.length ? 'desfazer' : 'editar')
    const op = ehUuid(operacaoId) ? operacaoId : crypto.randomUUID()
    const detalhe = { principal: pv.principal, adicionados: pv.adicionar.map(({ ao_vivo, ...x }) => ({ ...x, titulo: ao_vivo ? ao_vivo.titulo : null, quantidade_lida: ao_vivo ? ao_vivo.quantidade : null })),
      removidos: pv.remover, alertas_mostrados: pv.alertas.map((a) => a.motivo), quantidade_final: pv.quantidade_final, modo: pv.config.modo,
      // de onde veio a operação e quais PRODUTOS do catálogo o usuário selecionou (tela Produtos → "Agrupar selecionados")
      origem: origem === 'produtos' ? 'produtos' : 'estoque', produtos_selecionados: [...new Set((Array.isArray(produtos) ? produtos : []).map(String))].slice(0, 200) }
    let r
    try { r = await rpc('estoque_agrupamento_aplicar', { p_empresa: empresaId, p_operacao: op, p_produto: pv.principal.sku, p_usuario: usuarioId || null, p_acao: acao,
      p_adicionar: pv.adicionar.map((a) => ({ plataforma: a.plataforma, conta_ref: a.conta_ref, conta_nome: a.conta_nome, anuncio_id: a.anuncio_id, variacao_id: a.variacao_id, sku_original: a.sku_original })),
      p_remover: pv.remover.map((m) => m.id), p_detalhe: detalhe }) } catch (e) {
      // conflito detectado pelo banco (outro administrador agrupou ao mesmo tempo): nada foi gravado
      if (/agrupamento:/.test(e.message)) throw erroHttp(`${e.message.replace(/^rpc [^:]+: /, '')}. Gere a prévia de novo.`, 409)
      throw e
    }
    log(`🔗 [ESTOQUE] agrupamento ${acao} — ${pv.principal.sku}: +${pv.adicionar.length} / -${pv.remover.length} anúncio(s) (operação ${op}, usuário ${usuarioId || '-'})`)
    return { ok: true, operacao_id: op, acao, duplicado: !!(r && r.duplicado), adicionados: pv.adicionar.length, removidos: pv.remover.length, grupo: await detalheGrupo({ empresaId, produtoSku: pv.principal.sku }) }
  }

  // ── Tela PRODUTOS → "Agrupar selecionados": para cada PRODUTO selecionado, os anúncios vinculados a ele (ML e Shopee,
  // todas as contas/lojas) e a situação de agrupamento. SÓ LÊ o banco (nada é gravado, nada é consultado nas plataformas).
  // Produto ≠ anúncio: cada produto traz a lista dos SEUS anúncios; o agrupamento continua sendo feito por anúncio.
  async function produtosAnuncios({ empresaId, skus }) {
    const lista = [...new Set((Array.isArray(skus) ? skus : []).map((x) => String(x).trim()).filter(Boolean))]
    if (!lista.length) throw erroHttp('Selecione ao menos um produto.', 400)
    if (lista.length > 200) throw erroHttp('No máximo 200 produtos por agrupamento.', 400)
    const g = await grupos.carregar(empresaId)
    const cat = await catalogo(empresaId, g, await contasDaEmpresa(empresaId))
    const prods = await produtosMap(empresaId, lista)
    const porSku = new Map()
    for (const a of cat.values()) { if (!porSku.has(a.sku_original)) porSku.set(a.sku_original, []); porSku.get(a.sku_original).push(publico(a)) }
    return {
      produtos: lista.map((sku) => {
        const p = prods.get(sku)
        return { sku, nome: p ? p.name : null, estoque: p ? p.estoque_atual : null, foto: p ? p.photo || null : null, cadastrado: !!p, duplicado: !!(p && p.duplicado),
          agrupado_em: g.principalDe(sku), anuncios: (porSku.get(sku) || []).sort((a, b) => a.chave.localeCompare(b.chave)),
          // anúncios de OUTROS SKUs que já estão agrupados neste produto (quando ele já é principal)
          ja_agrupados: g.membros(sku).map((m) => ({ id: m.id, chave: chaveDe(m), plataforma: m.plataforma, conta_nome: m.conta_nome, anuncio_id: m.anuncio_id, variacao_id: m.variacao_id, sku_original: m.sku_original })) }
      })
    }
  }

  return { produtos, anuncios, aoVivo, listarGrupos, detalheGrupo, previa, confirmar, produtosAnuncios }
}

module.exports = { criarAgrupamento }
