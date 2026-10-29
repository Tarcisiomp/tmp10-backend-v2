// Estoque Central — ESTOQUE NORMAL × ESTOQUE FULL POR ANÚNCIO (Mercado Livre) — migração 27.
//
// DOIS SALDOS, SEMPRE SEPARADOS:
//   • NORMAL = estoque oficial do TMP10 (products.estoque_atual) do produto que o anúncio representa hoje (o PRINCIPAL, se o
//     anúncio estiver agrupado). Só muda por estoque_movimentar. É o número que o TMP10 envia aos anúncios NÃO Full.
//   • FULL   = unidades no armazém do Mercado Livre PARA AQUELE ANÚNCIO (GET /inventories/{inventory_id}/stock/fulfillment,
//     doc oficial "Envios Fulfillment"). Fica no anúncio. NÃO é estoque físico do vendedor, NÃO é somado ao normal, NÃO é
//     somado entre anúncios agrupados, NÃO vira movimento e NÃO é enviado a lugar nenhum (a API do ML só permite consultar).
//
// Falha na consulta do Full NUNCA vira zero: a situação fica 'erro' (ou 'indisponivel') com os números NULOS; o último valor
// válido aparece à parte, com a data dele. A lista do estoque normal funciona mesmo sem a migração 27 e com o ML fora do ar.
//
// SITUAÇÕES do Full: pendente (nunca consultado) · atualizado · erro (consulta falhou) · indisponivel (o ML não informa o Full
// deste anúncio — ex.: 404 seller_product_not_found, ou anúncio com variações) · sem_full (o anúncio não tem inventory_id).
const ROT = { mercadolivre: 'ML', shopee: 'Shopee' }
const erroHttp = (msg, status) => Object.assign(new Error(msg), { status })
const faltaObjeto = (e, nome) => e && (['PGRST202', 'PGRST205', '42P01', '42883'].includes(e.code) || (new RegExp(nome).test(String(e.message || '')) && /(does not exist|Could not find)/i.test(String(e.message || ''))))
const pedacos = (l, n) => { const r = []; for (let i = 0; i < l.length; i += n) r.push(l.slice(i, i + n)); return r }
const SITUACAO_NORMAL = { ok: 'atualizado', simulado: 'simulado', pendente: 'pendente', enviando: 'pendente', erro_temporario: 'pendente', erro: 'erro', bloqueado: 'erro', pausado_loop: 'erro' }

function criarFull({ sb, ml, grupos, q, rpc, log = console.log, agora = () => new Date(), dormir = () => Promise.resolve() }) {
  async function lerTodos(montar, contexto) {
    const todos = []
    for (let de = 0; ; de += 1000) {
      const lote = await q(montar().range(de, de + 999), contexto)
      todos.push(...(lote || []))
      if (!lote || lote.length < 1000) return todos
    }
  }
  async function contasML(empresaId) {
    const c = (await q(sb.from('ml_accounts').select('id, nickname, ml_user_id, platform, active, empresa_id, access_token, refresh_token, expires_at').eq('empresa_id', empresaId), 'contas')) || []
    return c.filter((x) => x.platform !== 'shopee')
  }
  const contaDoLink = (contas, l) => { const a = contas.filter((c) => (l.ml_user_id ? String(c.ml_user_id) === String(l.ml_user_id) : c.nickname === l.account_nickname)); return a.length === 1 ? a[0] : null }
  const refDoLink = (l) => (l.ml_user_id ? String(l.ml_user_id) : `nick:${l.account_nickname}`)

  // Anúncios do ML que o TMP10 conhece (vínculos), com o produto efetivo (principal, se agrupado)
  async function anunciosML(empresaId, g, contas) {
    const links = await lerTodos(() => sb.from('product_ml_links').select('sku, account_nickname, ml_item_id, ml_user_id, sincronizar, ml_variation_id').eq('empresa_id', empresaId), 'vínculos ML')
    const porChave = new Map()
    for (const l of links) {
      if (!l.ml_item_id) continue
      const c = contaDoLink(contas, l)
      const a = { conta_ref: refDoLink(l), conta_nome: c ? c.nickname : l.account_nickname, conta_conectada: !!(c && c.active === true), _conta: c,
        anuncio_id: String(l.ml_item_id), variacao_id: '', ml_variation_id: l.ml_variation_id || null, sku_vinculo: l.sku, sincronizar: l.sincronizar }
      a.chave = `${a.conta_ref}|${a.anuncio_id}|${a.variacao_id}`
      if (porChave.has(a.chave)) { const x = porChave.get(a.chave); x.outros_skus = [...new Set([...(x.outros_skus || []), l.sku])]; continue }
      const gr = g.doAnuncio('mercadolivre', a.anuncio_id, '')
      a.sku_efetivo = gr ? gr.produto_sku : l.sku
      a.agrupado_em = gr ? gr.produto_sku : null
      porChave.set(a.chave, a)
    }
    return [...porChave.values()]
  }

  // Saldos Full gravados (última consulta). Sem a migração 27 → { faltando: true } (a tela segue com o normal).
  async function fullGravados(empresaId, anuncioIds = null) {
    const linhas = []
    try {
      if (anuncioIds) {
        for (const l of pedacos([...new Set(anuncioIds)], 300)) {
          const r = await sb.from('estoque_full_saldos').select('*').eq('empresa_id', empresaId).in('anuncio_id', l)
          if (r.error) throw r.error
          linhas.push(...(r.data || []))
        }
      } else {
        for (let de = 0; ; de += 1000) {
          const r = await sb.from('estoque_full_saldos').select('*').eq('empresa_id', empresaId).order('id').range(de, de + 999)
          if (r.error) throw r.error
          linhas.push(...(r.data || [])); if (!r.data || r.data.length < 1000) break
        }
      }
    } catch (e) {
      if (faltaObjeto(e, 'estoque_full_saldos')) return { faltando: true, mapa: new Map() }
      return { erro: e.message || String(e), mapa: new Map() }
    }
    return { mapa: new Map(linhas.map((l) => [`${l.conta_ref}|${l.anuncio_id}|${l.variacao_id || ''}`, l])) }
  }

  const blocoFull = (f, falta, erroTabela) => {
    if (falta) return { situacao: 'pendente', motivo: 'migração 27 ainda não aplicada — o Full ainda não pode ser consultado/guardado' }
    if (erroTabela) return { situacao: 'erro', motivo: `não foi possível ler os saldos Full gravados (${erroTabela})` }
    if (!f) return { situacao: 'pendente', motivo: 'ainda não consultado' }
    return { situacao: f.situacao, inventory_id: f.inventory_id || null, disponivel: f.disponivel, nao_disponivel: f.nao_disponivel, total: f.total, detalhe: f.detalhe || null,
      erro: f.erro || null, consultado_em: f.consultado_em,
      ultimo_valido: f.valido_em ? { disponivel: f.valido_disponivel, nao_disponivel: f.valido_nao_disponivel, total: f.valido_total, em: f.valido_em } : null }
  }

  // ── Tela "Estoque Normal × Full por anúncio" (SÓ LÊ o banco; não chama o ML) ─────────────────────────────────────────
  async function saldos({ empresaId, conta = '', busca = '', situacaoFull = '', pagina = 1, porPagina = 100 }) {
    const g = await grupos.carregar(empresaId)
    const contas = await contasML(empresaId)
    let lista = await anunciosML(empresaId, g, contas)
    const qb = String(busca || '').trim().toLowerCase()
    // estoque NORMAL primeiro (não depende do Full)
    const skus = [...new Set(lista.map((a) => a.sku_efetivo))]
    const prods = new Map()
    for (const l of pedacos(skus, 300)) for (const p of ((await q(sb.from('products').select('sku, name, estoque_atual').eq('empresa_id', empresaId).in('sku', l), 'produtos')) || [])) prods.set(p.sku, prods.has(p.sku) ? { ...p, duplicado: true } : p)
    lista = lista.filter((a) => (!conta || a.conta_ref === conta) && (!qb || a.anuncio_id.toLowerCase().includes(qb) || a.sku_vinculo.toLowerCase().includes(qb) || a.sku_efetivo.toLowerCase().includes(qb)
      || String((prods.get(a.sku_efetivo) || {}).name || '').toLowerCase().includes(qb)))
    const fg = await fullGravados(empresaId, lista.length <= 3000 ? lista.map((a) => a.anuncio_id) : null)
    for (const a of lista) a.full = blocoFull(fg.mapa.get(a.chave), fg.faltando, fg.erro)
    if (situacaoFull) lista = lista.filter((a) => a.full.situacao === situacaoFull)
    lista.sort((a, b) => a.sku_efetivo.localeCompare(b.sku_efetivo) || a.chave.localeCompare(b.chave))
    const pp = Math.max(1, Math.min(Number(porPagina) || 100, 500)); const pg = Math.max(1, Number(pagina) || 1)
    const pag = lista.slice((pg - 1) * pp, pg * pp)
    // data/hora do último movimento aplicado (estoque normal) e do último envio a cada anúncio (fila)
    const resumo = new Map(); let avisoResumo = null
    const skusPag = [...new Set(pag.map((a) => a.sku_efetivo))]
    if (skusPag.length) {
      const r = await sb.rpc('estoque_saldo_normal_resumo', { p_empresa: empresaId, p_skus: skusPag })
      if (r.error) avisoResumo = faltaObjeto(r.error, 'estoque_saldo_normal_resumo') ? 'migração 27 ainda não aplicada — data do último movimento indisponível' : `data do último movimento indisponível (${r.error.message})`
      else for (const x of r.data || []) resumo.set(x.sku, x)
    }
    const filaPor = new Map()
    for (const l of pedacos([...new Set(pag.map((a) => a.anuncio_id))], 300)) {
      for (const f of ((await q(sb.from('estoque_sync_fila').select('sku, conta_ref, anuncio_id, variacao_id, status, quantidade_enviada, quantidade_confirmada, ultimo_erro, atualizado_em, enviado_em')
        .eq('empresa_id', empresaId).eq('destino', 'mercadolivre').in('anuncio_id', l), 'fila')) || [])) filaPor.set(`${f.conta_ref}|${f.anuncio_id}|${f.variacao_id || ''}`, f)
    }
    const contasTela = contas.filter((c) => c.active === true).map((c) => ({ conta_ref: String(c.ml_user_id), nome: c.nickname }))
    return {
      total: lista.length, pagina: pg, paginas: Math.max(1, Math.ceil(lista.length / pp)), contas: contasTela,
      full_disponivel: !fg.faltando, avisos: [fg.faltando ? 'Migração 27 ainda não aplicada: o estoque normal aparece; o Full fica "pendente" até a migração ser aplicada.' : null, fg.erro ? `Saldos Full gravados indisponíveis agora: ${fg.erro}` : null, avisoResumo].filter(Boolean),
      regra: 'Estoque normal e Full são saldos SEPARADOS. O Full é por anúncio, não é somado ao normal nem entre anúncios agrupados, e falha de consulta nunca vira zero.',
      anuncios: pag.map((a) => {
        const p = prods.get(a.sku_efetivo); const f = filaPor.get(a.chave); const r = resumo.get(a.sku_efetivo)
        const normal = !p ? { situacao: 'erro', estoque: null, motivo: `produto ${a.sku_efetivo} não cadastrado no TMP10` }
          : p.duplicado ? { situacao: 'erro', estoque: null, motivo: `mais de um produto com o SKU ${a.sku_efetivo}` }
            : p.estoque_atual === null || p.estoque_atual === undefined ? { situacao: 'erro', estoque: null, motivo: 'produto sem estoque oficial definido' }
              : { situacao: 'atualizado', estoque: p.estoque_atual }
        normal.sku = a.sku_efetivo; normal.produto = p ? p.name : null
        normal.ultimo_movimento_em = r ? r.ultimo_movimento_em : null; normal.ultima_origem = r ? r.ultima_origem : null
        normal.envio = f ? { situacao: SITUACAO_NORMAL[f.status] || f.status, status_fila: f.status, enviado: f.quantidade_enviada, confirmado: f.quantidade_confirmada,
          enviado_em: f.enviado_em, atualizado_em: f.atualizado_em, erro: f.ultimo_erro } : { situacao: 'sem_envio' }
        return { chave: a.chave, conta_ref: a.conta_ref, conta_nome: a.conta_nome, conta_conectada: a.conta_conectada, anuncio_id: a.anuncio_id, sku_vinculo: a.sku_vinculo,
          sku_tmp10: a.sku_efetivo, agrupado_em: a.agrupado_em, vinculo_ambiguo: a.outros_skus ? [a.sku_vinculo, ...a.outros_skus] : null, ml_variation_id: a.ml_variation_id,
          normal, full: a.full }
      })
    }
  }

  // ── Histórico de consultas Full de um anúncio (só leitura) ──────────────────────────────────────────────────────────
  async function historico({ empresaId, contaRef, anuncioId, limite = 50 }) {
    if (!anuncioId) throw erroHttp('Informe o anúncio.', 400)
    let c = sb.from('estoque_full_leituras').select('inventory_id, situacao, disponivel, nao_disponivel, total, detalhe, erro, consultado_em, sku_vinculo')
      .eq('empresa_id', empresaId).eq('anuncio_id', String(anuncioId)).order('consultado_em', { ascending: false }).limit(Math.min(Number(limite) || 50, 200))
    if (contaRef) c = c.eq('conta_ref', String(contaRef))
    const r = await c
    if (r.error) { if (faltaObjeto(r.error, 'estoque_full_leituras')) return { leituras: [], aviso: 'migração 27 ainda não aplicada' }; throw new Error(`histórico Full: ${r.error.message}`) }
    return { leituras: r.data || [] }
  }

  // Validação da resposta do Full ANTES de aceitar o número (inclusive ZERO). Campos da doc oficial:
  //   inventory_id da resposta = o pedido · total = available_quantity + not_available_quantity (definição da doc) ·
  //   external_references[type=item].id = o anúncio. Qualquer inconsistência → ERRO (o número não é usado).
  function validarFull(f, inventoryPedido, anuncioId) {
    if (f.inventory_id && String(f.inventory_id) !== String(inventoryPedido)) return { erro: `o ML devolveu o inventory ${f.inventory_id}, mas foi pedido ${inventoryPedido} — resposta não usada` }
    if (f.nao_disponivel !== null && f.nao_disponivel !== undefined && f.total !== f.disponivel + f.nao_disponivel)
      return { erro: `resposta inconsistente do ML: total ${f.total} ≠ disponível ${f.disponivel} + não disponível ${f.nao_disponivel} — número não usado` }
    if ((f.nao_disponivel === null || f.nao_disponivel === undefined) && f.total < f.disponivel) return { erro: `resposta inconsistente do ML: total ${f.total} menor que disponível ${f.disponivel} — número não usado` }
    const refs = (f.referencias || []).filter((x) => x && x.type === 'item' && x.id)
    if (refs.length && !refs.some((x) => String(x.id) === String(anuncioId))) return { erro: `o inventory ${inventoryPedido} aponta para outro anúncio (${refs.map((x) => x.id).join(', ')}) — não usado` }
    return { validacao: { inventory_confere: true, total_confere: f.nao_disponivel !== null && f.nao_disponivel !== undefined, anuncio_confere: refs.length ? true : null } }
  }

  // Anúncios com VENDAS Full/FBS no histórico do TMP10 (ml_orders.is_fulfillment). Usa estoque_anuncios_full (migração 22, uma
  // consulta só); se ela ainda não existir no banco, usa estoque_anuncio_tem_full (migração 21, anúncio por anúncio) — mesmo
  // resultado, sem depender da 22. Devolve { ids: Set, modo: 'lote' | 'um_a_um' }. Outro erro sobe (não é engolido).
  async function vendasFull(empresaId, anuncioIds) {
    const r = await sb.rpc('estoque_anuncios_full', { p_empresa: empresaId, p_dias: 90 })
    if (!r.error) return { ids: new Set((r.data || []).map((x) => String(typeof x === 'object' && x !== null ? Object.values(x)[0] : x))), modo: 'lote' }
    if (!faltaObjeto(r.error, 'estoque_anuncios_full')) throw new Error(`rpc estoque_anuncios_full: ${r.error.message}`)
    const ids = new Set()
    for (const id of [...new Set((anuncioIds || []).map(String))]) if (await rpc('estoque_anuncio_tem_full', { p_empresa: empresaId, p_anuncio: id, p_dias: 90 })) ids.add(id)
    return { ids, modo: 'um_a_um' }
  }

  // ── Consulta AO VIVO (só GET no ML): inventory_id do anúncio e saldo Full ────────────────────────────────────────────
  // anuncios: [{ chave, conta_ref, conta_nome, anuncio_id, variacao_id, sku_vinculo, _conta, conta_conectada }]
  // devolve Map(chave → leitura { situacao, inventory_id, disponivel, nao_disponivel, total, detalhe, erro, consultado_em })
  async function lerAoVivo(anuncios) {
    const res = new Map()
    const porConta = new Map()
    for (const a of anuncios) {
      if (!a._conta || !a.conta_conectada) { res.set(a.chave, { situacao: 'erro', erro: 'conta do anúncio não conectada/ativa nesta empresa', consultado_em: agora().toISOString() }); continue }
      if (a.ml_variation_id) { res.set(a.chave, { situacao: 'indisponivel', erro: 'vínculo com variação do ML — Full por variação fora desta versão (PRECISA CONFIRMAR)', consultado_em: agora().toISOString() }); continue }
      if (!porConta.has(a._conta.id)) porConta.set(a._conta.id, { conta: a._conta, itens: [] })
      porConta.get(a._conta.id).itens.push(a)
    }
    for (const { conta, itens } of porConta.values()) for (const lote of pedacos(itens, 20)) {
      let mapa = null, erro = null
      try { mapa = await ml.lerAnuncios(conta, [...new Set(lote.map((a) => a.anuncio_id))]) } catch (e) { erro = e.message }
      await dormir()
      for (const a of lote) {
        const quando = () => agora().toISOString()
        const l = mapa ? mapa.get(a.anuncio_id) : null
        if (!l || l.erro) { res.set(a.chave, { situacao: 'erro', erro: (l && l.erro) || erro || 'anúncio não devolvido pelo ML', consultado_em: quando() }); continue }
        if (l.variacoes > 0) { res.set(a.chave, { situacao: 'indisponivel', inventory_id: l.inventory_id || null, erro: `anúncio com ${l.variacoes} variação(ões): o ML tem um inventory_id por variação — Full por variação fora desta versão`, consultado_em: quando() }); continue }
        if (!l.inventory_id) { res.set(a.chave, { situacao: 'sem_full', inventory_id: null, consultado_em: quando() }); continue }
        try {
          const f = await ml.lerEstoqueFull(conta, l.inventory_id)
          const v = validarFull(f, l.inventory_id, a.anuncio_id)
          if (v.erro) res.set(a.chave, { situacao: 'erro', inventory_id: l.inventory_id, erro: v.erro, consultado_em: quando() })
          else res.set(a.chave, { situacao: 'atualizado', inventory_id: l.inventory_id, disponivel: f.disponivel, nao_disponivel: f.nao_disponivel, total: f.total, detalhe: f.detalhe,
            validacao: v.validacao, consultado_em: quando() })
        } catch (e) {
          const http = e && e.http
          res.set(a.chave, http === 404
            ? { situacao: 'indisponivel', inventory_id: l.inventory_id, erro: `o ML não informou o Full deste anúncio (HTTP 404): ${e.message}`, consultado_em: quando() }
            : { situacao: 'erro', inventory_id: l.inventory_id, erro: e.message, consultado_em: quando() })
        }
        await dormir()
      }
    }
    return res
  }

  // ── Consulta do Full em segundo plano (uma por empresa) — SÓ LÊ o ML; grava SÓ as tabelas do Full ────────────────────
  const trabalhos = new Map()
  async function consultar({ empresaId, contas: refs = null, chaves = null, usuarioId = null, progresso = () => {} }) {
    const g = await grupos.carregar(empresaId)
    const contas = await contasML(empresaId)
    let lista = await anunciosML(empresaId, g, contas)
    if (Array.isArray(refs) && refs.length) lista = lista.filter((a) => refs.includes(a.conta_ref))
    if (Array.isArray(chaves) && chaves.length) { const s = new Set(chaves.map(String)); lista = lista.filter((a) => s.has(a.chave)) }
    const resumo = { anuncios: lista.length, atualizado: 0, erro: 0, indisponivel: 0, sem_full: 0, gravados: 0 }
    for (const lote of pedacos(lista, 50)) {
      const lidos = await lerAoVivo(lote)
      const leituras = lote.map((a) => { const l = lidos.get(a.chave) || { situacao: 'erro', erro: 'sem leitura', consultado_em: agora().toISOString() }
        resumo[l.situacao] = (resumo[l.situacao] || 0) + 1
        return { conta_ref: a.conta_ref, conta_nome: a.conta_nome, anuncio_id: a.anuncio_id, variacao_id: a.variacao_id, sku_vinculo: a.sku_vinculo, inventory_id: l.inventory_id || null,
          situacao: l.situacao, disponivel: l.situacao === 'atualizado' ? l.disponivel : null, nao_disponivel: l.situacao === 'atualizado' ? l.nao_disponivel : null,
          total: l.situacao === 'atualizado' ? l.total : null, detalhe: l.situacao === 'atualizado' ? l.detalhe : null, erro: l.erro || null, consultado_em: l.consultado_em } })
      const n = await rpc('estoque_full_registrar', { p_empresa: empresaId, p_leituras: leituras, p_usuario: usuarioId || null })
      resumo.gravados += Number(n) || 0
      progresso(resumo)
    }
    log(`📦 [ESTOQUE] consulta Full (empresa ${empresaId}): ${resumo.anuncios} anúncio(s) — ${resumo.atualizado} atualizado(s), ${resumo.sem_full} sem Full, ${resumo.indisponivel} indisponível(is), ${resumo.erro} erro(s). Nenhum estoque alterado.`)
    return resumo
  }
  async function iniciarConsulta(empresaId, opcoes = {}) {
    const atual = trabalhos.get(empresaId)
    if (atual && atual.rodando) return atual
    // sem a migração 27 não adianta consultar (não há onde guardar): avisa antes de chamar o ML
    const t0 = await sb.from('estoque_full_saldos').select('id').eq('empresa_id', empresaId).limit(1)
    if (t0.error) throw erroHttp(faltaObjeto(t0.error, 'estoque_full_saldos') ? 'A migração 27 (estoque Full por anúncio) ainda não foi aplicada no banco. O estoque normal continua funcionando; o Full só pode ser consultado depois da migração.' : `Não foi possível preparar a consulta: ${t0.error.message}`, faltaObjeto(t0.error, 'estoque_full_saldos') ? 409 : 500)
    const t = { rodando: true, iniciado_em: agora().toISOString(), terminado_em: null, resumo: null, erro: null }
    trabalhos.set(empresaId, t)
    consultar({ ...opcoes, empresaId, progresso: (r) => { t.resumo = { ...r } } })
      .then((r) => { t.resumo = r })
      .catch((e) => { t.erro = e.message; log(`❌ [ESTOQUE] consulta Full ${empresaId}: ${e.message}`) })
      .finally(() => { t.rodando = false; t.terminado_em = agora().toISOString() })
    return t
  }
  const statusConsulta = (empresaId) => trabalhos.get(empresaId) || { rodando: false, resumo: null }

  // Full gravado de UM anúncio (para proteções: aceitar divergência). null = sem informação (tabela ausente ou nunca consultado).
  async function gravadoDe(empresaId, contaRef, anuncioId) {
    const r = await sb.from('estoque_full_saldos').select('conta_ref, situacao, inventory_id, consultado_em').eq('empresa_id', empresaId).eq('anuncio_id', String(anuncioId))
    if (r.error) return null
    const l = (r.data || []).filter((x) => !contaRef || x.conta_ref === String(contaRef))
    return l.length ? l : null
  }

  return { saldos, historico, lerAoVivo, vendasFull, validarFull, consultar, iniciarConsulta, statusConsulta, gravadoDe, rotulo: ROT }
}

module.exports = { criarFull }
