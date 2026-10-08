// Estoque Central TMP10 — serviço único (migração 21).
//
// REGRAS
//   • O TMP10 é a fonte oficial. O estoque só muda por estoque_movimentar (banco): trava a linha do produto,
//     grava o movimento e usa uma chave de idempotência (a mesma venda/cancelamento/ajuste nunca aplica duas vezes).
//   • Toda mudança aplicada coloca na fila TODOS os anúncios vinculados ao SKU (ML e Shopee). A fila junta
//     alterações seguidas: vai um envio por anúncio, sempre com o número ATUAL do TMP10 (absoluto, nunca "tira 1").
//   • O número que o ML/Shopee mostra NUNCA vira movimento sozinho. Diferença vira divergência (uma por anúncio);
//     só uma ação explícita ("aceitar") transforma em movimento. Por isso não existe loop TMP10 → ML → TMP10.
//   • Envio real só se: ESTOQUE_ENVIO_HABILITADO=1 no Railway E a empresa estiver em 'ativo', ou em 'piloto' com o
//     SKU na lista do piloto. Fora disso tudo roda em SIMULAÇÃO (calcula, registra, não envia).
//   • Full (ML) e FBS (Shopee) nunca recebem envio; anúncio de outra conta/empresa nunca recebe envio.

const crypto = require('crypto')
const { ErroPlataforma, resumir } = require('./plataformas')

const ESPERAS = [60, 300, 900, 3600, 10800]   // segundos entre tentativas (1 min, 5 min, 15 min, 1 h, 3 h)
const MAX_TENTATIVAS = 6
const LIMITE_LOOP = { envios: 10, minutos: 10 } // mais que isso no mesmo anúncio = pausa ("pausado_loop")
const ROTULO = { mercadolivre: 'Mercado Livre', shopee: 'Shopee' }
const ehShopee = (conta) => conta.platform === 'shopee'
const inteiro = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)))

function criarServicoEstoque({ sb, ml, shopee, log = console.log, envioHabilitado = () => false, permitirSandbox = false,
  agendar = true, esperaEntreEnviosMs = 300 }) {
  const dormir = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

  async function q(promessa, contexto) {
    const r = await promessa
    if (r && r.error) throw new Error(`${contexto}: ${r.error.message || r.error}`)
    return r ? r.data : null
  }
  async function rpc(nome, args) { return q(sb.rpc(nome, args), `rpc ${nome}`) }

  // ── Movimentação oficial ─────────────────────────────────────────────────────────────────────────────
  async function movimentar({ empresaId, sku, tipo, quantidade, origem, motivo = null, referencia = null, usuarioId = null, processo = null, esperado = null }) {
    const r = await rpc('estoque_movimentar', {
      p_empresa: empresaId, p_sku: String(sku), p_tipo: tipo, p_quantidade: quantidade, p_origem: origem,
      p_motivo: motivo, p_referencia: referencia, p_usuario: usuarioId, p_processo: processo, p_esperado: esperado
    })
    if (r && r.aplicado && !r.duplicado) {
      if (r.negativo) log(`⚠️ [ESTOQUE] ${sku} ficou NEGATIVO (${r.novo}) — empresa ${empresaId}, origem ${origem}. O marketplace recebe 0.`)
      await enfileirarSku(empresaId, String(sku), motivo || origem, r.movimento_id)
      agendarProcessamento()
    } else if (r && !r.aplicado && !r.duplicado && r.erro && r.erro !== 'estoque_mudou') {
      log(`⚠️ [ESTOQUE] movimento NÃO aplicado (${r.erro}) — ${sku}, empresa ${empresaId}, origem ${origem}, ref ${referencia}`)
    }
    return r
  }

  // Venda nova (ML ou Shopee): baixa cada SKU uma única vez por pedido
  async function registrarVenda({ empresaId, plataforma, pedidoId, itens, processo = 'sincronizacao-pedidos' }) {
    if (!empresaId) { log(`⚠️ [ESTOQUE] venda ${plataforma} ${pedidoId} sem empresa — estoque NÃO baixado`); return [] }
    const porSku = new Map()
    for (const it of (itens || [])) {
      const sku = it && it.sku ? String(it.sku).trim() : ''
      if (!sku) continue
      porSku.set(sku, (porSku.get(sku) || 0) + (inteiro(it.qty) > 0 ? inteiro(it.qty) : 1))
    }
    const resultados = []
    for (const [sku, qtd] of porSku) {
      try {
        resultados.push({ sku, ...(await movimentar({
          empresaId, sku, tipo: 'saida', quantidade: qtd, origem: `venda_${plataforma}`,
          motivo: `Venda ${ROTULO[plataforma] || plataforma} ${pedidoId}`, referencia: `venda:${plataforma}:${pedidoId}:${sku}`, processo
        })) })
      } catch (e) {
        log(`❌ [ESTOQUE] falha ao baixar ${sku} da venda ${plataforma} ${pedidoId}: ${e.message}`)
        resultados.push({ sku, ok: false, erro: e.message })
      }
    }
    return resultados
  }

  // Cancelamento: devolve SOMENTE o que a venda baixou pelo fluxo oficial (venda Full, ou anterior ao estoque central, não)
  async function registrarCancelamento({ empresaId, plataforma, pedidoId, processo = 'cancelamento' }) {
    if (!empresaId) return []
    const pedido = await q(sb.from('ml_orders').select('items').eq('empresa_id', empresaId).eq('ml_order_id', String(pedidoId)).maybeSingle(), 'pedido do cancelamento')
    const skus = [...new Set(((pedido && pedido.items) || []).map((i) => (i && i.sku ? String(i.sku).trim() : '')).filter(Boolean))]
    const resultados = []
    for (const sku of skus) {
      const venda = await q(sb.from('estoque_movimentos').select('quantidade, aplicado').eq('empresa_id', empresaId).eq('referencia', `venda:${plataforma}:${pedidoId}:${sku}`).maybeSingle(), 'movimento da venda')
      if (!venda || !venda.aplicado || !(venda.quantidade < 0)) { resultados.push({ sku, devolvido: false, motivo: 'venda não baixou estoque pelo fluxo oficial' }); continue }
      const r = await movimentar({
        empresaId, sku, tipo: 'entrada', quantidade: -venda.quantidade, origem: `cancelamento_${plataforma}`,
        motivo: `Cancelamento ${ROTULO[plataforma] || plataforma} ${pedidoId}`, referencia: `cancelamento:${plataforma}:${pedidoId}:${sku}`, processo
      })
      resultados.push({ sku, devolvido: !!(r && r.aplicado && !r.duplicado), duplicado: !!(r && r.duplicado), novo: r && r.novo })
    }
    return resultados
  }

  // Ajuste manual no TMP10 (tela): "fica com N", só se o estoque ainda for o que estava na tela
  async function ajustar({ empresaId, sku, novoEstoque, estoqueEsperado, motivo, usuarioId, idOperacao }) {
    const novo = inteiro(novoEstoque)
    if (novo === null || novo < 0 || novo > 1000000) throw Object.assign(new Error('Informe um estoque entre 0 e 1.000.000.'), { status: 400 })
    if (!sku || String(sku).length > 120) throw Object.assign(new Error('SKU inválido.'), { status: 400 })
    const esperado = estoqueEsperado === null || estoqueEsperado === undefined || estoqueEsperado === '' ? null : inteiro(estoqueEsperado)
    const op = /^[A-Za-z0-9_-]{8,64}$/.test(String(idOperacao || '')) ? String(idOperacao) : crypto.randomUUID()
    const r = await movimentar({
      empresaId, sku: String(sku), tipo: 'definir', quantidade: novo, origem: 'ajuste_manual',
      motivo: String(motivo || 'Ajuste manual no TMP10').slice(0, 200), referencia: `ajuste:${op}`, usuarioId, processo: 'erp', esperado
    })
    if (r && r.erro === 'estoque_mudou') throw Object.assign(new Error(`O estoque deste produto mudou para ${r.anterior} enquanto você editava. Confira e salve de novo.`), { status: 409, atual: r.anterior })
    if (r && r.erro === 'produto_inexistente') throw Object.assign(new Error('Produto não encontrado nesta empresa.'), { status: 404 })
    if (r && r.erro === 'sku_duplicado') throw Object.assign(new Error('Há mais de um produto com este SKU. Corrija o cadastro antes de ajustar.'), { status: 409 })
    return r
  }

  // ── Fila ───────────────────────────────────────────────────────────────────────────────────────────────
  async function enfileirarSku(empresaId, sku, motivo, movimentoId = null) {
    const linksML = await q(sb.from('product_ml_links').select('account_nickname, ml_item_id, ml_user_id').eq('empresa_id', empresaId).eq('sku', sku), 'vínculos ML')
    const linksSh = await q(sb.from('product_shopee_links').select('shop_id, item_id, model_id').eq('empresa_id', empresaId).eq('sku', sku), 'vínculos Shopee')
    let n = 0
    for (const l of (linksML || [])) {
      if (!l.ml_item_id) continue
      await rpc('estoque_fila_enfileirar', { p_empresa: empresaId, p_sku: sku, p_destino: 'mercadolivre',
        p_conta_ref: l.ml_user_id ? String(l.ml_user_id) : `nick:${l.account_nickname}`, p_anuncio: String(l.ml_item_id), p_variacao: '',
        p_motivo: motivo ? String(motivo).slice(0, 200) : null, p_movimento: movimentoId })
      n++
    }
    for (const l of (linksSh || [])) {
      if (!l.item_id || !l.shop_id) continue
      await rpc('estoque_fila_enfileirar', { p_empresa: empresaId, p_sku: sku, p_destino: 'shopee',
        p_conta_ref: String(l.shop_id), p_anuncio: String(l.item_id), p_variacao: l.model_id ? String(l.model_id) : '',
        p_motivo: motivo ? String(motivo).slice(0, 200) : null, p_movimento: movimentoId })
      n++
    }
    return n // 0 = produto sem anúncio vinculado: estoque só no TMP10, sem erro
  }

  // Movimentos registrados pelo gatilho (alteração direta / cadastro) → fila
  async function processarMovimentosPendentes() {
    const pend = await q(sb.from('estoque_movimentos').select('id, empresa_id, sku').eq('sincronizacao_pendente', true).limit(500), 'movimentos pendentes')
    if (!pend || !pend.length) return 0
    const feitos = new Set()
    for (const m of pend) {
      const k = `${m.empresa_id}::${m.sku}`
      if (feitos.has(k)) continue
      feitos.add(k)
      try { await enfileirarSku(m.empresa_id, m.sku, 'Alteração registrada pelo banco', m.id) } catch (e) { log(`❌ [ESTOQUE] enfileirar ${m.sku}: ${e.message}`) }
    }
    await q(sb.from('estoque_movimentos').update({ sincronizacao_pendente: false }).in('id', pend.map((m) => m.id)), 'desmarcar pendentes')
    return feitos.size
  }

  let timer = null
  function agendarProcessamento() {
    if (!agendar || timer) return
    timer = setTimeout(async () => {
      timer = null
      try { await processarMovimentosPendentes(); await processarFila() } catch (e) { log(`❌ [ESTOQUE] processamento: ${e.message}`) }
    }, 1500)
    if (timer.unref) timer.unref()
  }

  async function lerConfig(empresaId) {
    const c = await q(sb.from('estoque_sync_config').select('modo, skus_piloto, atualizado_em').eq('empresa_id', empresaId).maybeSingle(), 'config')
    return { modo: (c && c.modo) || 'desligado', skus_piloto: (c && c.skus_piloto) || [], atualizado_em: c ? c.atualizado_em : null }
  }

  // Decisão de envio de UM SKU com a configuração ATUAL (a mesma usada no processamento da fila e mostrada na tela):
  // real só com ESTOQUE_ENVIO_HABILITADO=1 E (empresa 'ativo' OU 'piloto' com o SKU na lista, comparação exata).
  function decidirEnvio(cfg, sku) {
    if (!envioHabilitado()) return { real: false, motivo: 'envio desligado no servidor (ESTOQUE_ENVIO_HABILITADO≠1)' }
    if (cfg.modo === 'ativo') return { real: true, motivo: 'modo ativo' }
    if (cfg.modo === 'piloto') return (cfg.skus_piloto || []).includes(sku) ? { real: true, motivo: 'SKU no piloto' } : { real: false, motivo: 'SKU fora do piloto' }
    return { real: false, motivo: `modo da empresa: ${cfg.modo}` }
  }

  async function registrarLog(item, resultado, extra = {}) {
    try {
      await q(sb.from('estoque_sync_log').insert({ fila_id: item.id, empresa_id: item.empresa_id, sku: item.sku, destino: item.destino,
        conta_ref: item.conta_ref, anuncio_id: item.anuncio_id, variacao_id: item.variacao_id, versao: item.versao,
        quantidade: extra.quantidade ?? null, resultado, http_status: extra.http ?? null, resposta: extra.resposta ? resumir(extra.resposta) : null }), 'log')
    } catch (e) { log(`[ESTOQUE] não gravou o log: ${e.message}`) }
  }

  // Valida conta + vínculo do destino (empresa certa, conta dona do anúncio). Devolve { conta, link } ou { bloqueio }
  async function resolverDestino(item) {
    if (item.destino === 'mercadolivre') {
      let consulta = sb.from('ml_accounts').select('id, nickname, ml_user_id, platform, active, empresa_id, access_token, refresh_token, expires_at').eq('empresa_id', item.empresa_id)
      consulta = item.conta_ref.startsWith('nick:') ? consulta.eq('nickname', item.conta_ref.slice(5)) : consulta.eq('ml_user_id', item.conta_ref)
      const contas = ((await q(consulta, 'conta ML')) || []).filter((c) => !ehShopee(c) && c.active === true)
      if (contas.length !== 1) return { bloqueio: contas.length ? 'mais de uma conta do Mercado Livre com este identificador nesta empresa' : 'conta do Mercado Livre deste anúncio não está conectada/ativa nesta empresa' }
      const conta = contas[0]
      const links = await q(sb.from('product_ml_links').select('account_nickname, ml_item_id, ml_user_id, sincronizar, ml_variation_id').eq('empresa_id', item.empresa_id).eq('sku', item.sku).eq('ml_item_id', item.anuncio_id), 'vínculo ML')
      const link = (links || []).find((l) => l.account_nickname === conta.nickname)
      if (!link) return { bloqueio: 'vínculo SKU ↔ anúncio não existe mais (ou é de outra conta)' }
      if (link.ml_user_id && String(link.ml_user_id) !== String(conta.ml_user_id)) return { bloqueio: 'vínculo aponta para outra conta do Mercado Livre' }
      if (link.sincronizar === false) return { bloqueio: 'sincronização desligada neste anúncio' }
      if (link.ml_variation_id) return { bloqueio: 'anúncio com variação no ML — PRECISA CONFIRMAR o envio por variação' }
      return { conta, link }
    }
    const contas = ((await q(sb.from('ml_accounts').select('id, nickname, ml_user_id, platform, active, empresa_id, access_token, refresh_token, expires_at')
      .eq('empresa_id', item.empresa_id).eq('platform', 'shopee').eq('ml_user_id', item.conta_ref), 'conta Shopee')) || []).filter((c) => c.active === true)
    if (contas.length !== 1) return { bloqueio: contas.length ? 'mais de uma loja Shopee com este shop_id nesta empresa' : 'loja Shopee deste anúncio não está conectada/ativa nesta empresa' }
    const links = await q(sb.from('product_shopee_links').select('shop_id, item_id, model_id, sincronizar').eq('empresa_id', item.empresa_id).eq('sku', item.sku).eq('shop_id', item.conta_ref), 'vínculo Shopee')
    const link = (links || []).find((l) => String(l.item_id) === item.anuncio_id && (l.model_id ? String(l.model_id) : '') === item.variacao_id)
    if (!link) return { bloqueio: 'vínculo SKU ↔ item/variação da Shopee não existe mais' }
    if (link.sincronizar === false) return { bloqueio: 'sincronização desligada neste anúncio' }
    return { conta: contas[0], link }
  }

  async function processarItem(item) {
    const concluir = async (status, { alvo = null, enviada = null, confirmada = null, erro = null, atraso = 0, http = null, resposta = null } = {}) => {
      const final = await rpc('estoque_fila_concluir', { p_id: item.id, p_versao: item.versao, p_status: status, p_alvo: alvo,
        p_enviada: enviada, p_confirmada: confirmada, p_erro: erro, p_atraso_segundos: atraso })
      await registrarLog(item, status, { quantidade: enviada ?? alvo, http, resposta: resposta || erro })
      // envio confirmado (a plataforma mostra o número do TMP10): a divergência aberta deste anúncio se resolve sozinha
      if (status === 'ok' && enviada !== null && confirmada === enviada) {
        try {
          await rpc('estoque_divergencia_registrar', { p_empresa: item.empresa_id, p_sku: item.sku, p_chave: `${item.destino}:${item.conta_ref}:${item.anuncio_id}:${item.variacao_id}`,
            p_plataforma: item.destino, p_conta: item.conta_ref, p_anuncio: item.anuncio_id, p_variacao: item.variacao_id, p_tmp10: enviada, p_plataforma_qtd: confirmada })
        } catch (e) { log(`[ESTOQUE] não resolveu a divergência de ${item.anuncio_id}: ${e.message}`) }
      }
      return final
    }
    // 1) produto e número oficial
    const prods = await q(sb.from('products').select('id, estoque_atual').eq('empresa_id', item.empresa_id).eq('sku', item.sku), 'produto')
    if (!prods || prods.length !== 1) return concluir('bloqueado', { erro: prods && prods.length > 1 ? 'mais de um produto com este SKU' : 'produto não cadastrado no TMP10' })
    if (prods[0].estoque_atual === null || prods[0].estoque_atual === undefined) return concluir('bloqueado', { erro: 'produto sem estoque oficial definido no TMP10' })
    const alvo = Math.max(0, inteiro(prods[0].estoque_atual))
    // 2) conta e vínculo certos
    const destino = await resolverDestino(item)
    if (destino.bloqueio) return concluir('bloqueado', { alvo, erro: destino.bloqueio })
    // 3) Full / FBS nunca recebe envio
    if (await rpc('estoque_anuncio_tem_full', { p_empresa: item.empresa_id, p_anuncio: item.anuncio_id, p_dias: 90 })) {
      return concluir('bloqueado', { alvo, erro: item.destino === 'shopee' ? 'anúncio com vendas FBS (Full da Shopee) — estoque fica com a Shopee' : 'anúncio com vendas Full — estoque fica com o Mercado Livre' })
    }
    if (item.destino === 'shopee' && shopee.ehSandbox() && !permitirSandbox) return concluir('bloqueado', { alvo, erro: 'SHOPEE_HOST aponta para o ambiente de TESTE (sandbox) — envio bloqueado' })
    // 4) modo de envio
    const cfg = await lerConfig(item.empresa_id)
    const decisao = decidirEnvio(cfg, item.sku)
    if (!decisao.real) return concluir('simulado', { alvo, erro: `SIMULAÇÃO — enviaria ${alvo}. Não enviado: ${decisao.motivo}` })
    // 5) proteção contra loop: envios demais no mesmo anúncio em pouco tempo
    const desde = new Date(Date.now() - LIMITE_LOOP.minutos * 60000).toISOString()
    const recentes = await q(sb.from('estoque_sync_log').select('id').eq('fila_id', item.id).in('resultado', ['ok', 'erro', 'erro_temporario']).gte('criado_em', desde), 'log recente')
    if ((recentes || []).length >= LIMITE_LOOP.envios) {
      log(`🛑 [ESTOQUE] anúncio ${item.anuncio_id} (${item.sku}) pausado: ${recentes.length} envios em ${LIMITE_LOOP.minutos} min`)
      return concluir('pausado_loop', { alvo, erro: `${recentes.length} envios em ${LIMITE_LOOP.minutos} minutos — pausado para conferência manual` })
    }
    // 6) envio
    try {
      if (item.destino === 'mercadolivre') {
        const antes = (await ml.lerAnuncios(destino.conta, [item.anuncio_id])).get(item.anuncio_id)
        if (!antes || antes.erro) return concluir('erro', { alvo, erro: (antes && antes.erro) || 'anúncio não encontrado no Mercado Livre' })
        if (antes.variacoes > 0) return concluir('bloqueado', { alvo, erro: `anúncio com ${antes.variacoes} variação(ões) no ML — PRECISA CONFIRMAR o envio por variação` })
        const r = await ml.enviar(destino.conta, item.anuncio_id, alvo)
        const depois = (await ml.lerAnuncios(destino.conta, [item.anuncio_id]).catch(() => new Map())).get(item.anuncio_id)
        const confirmada = depois && !depois.erro ? depois.quantidade : null
        return concluir('ok', { alvo, enviada: alvo, confirmada, http: r.http, resposta: `antes ${antes.quantidade} → enviado ${alvo} → lido ${confirmada}`,
          erro: confirmada !== null && confirmada !== alvo ? `enviado ${alvo}, o ML mostra ${confirmada} — conferir` : null })
      }
      // Shopee: lê o anúncio ANTES de enviar (como já é feito no ML). Se a leitura falhar ou o item/variação não
      // existir na loja, NÃO envia (anúncio com erro continua sem envio). Erro de rede/limite: tenta de novo depois.
      const lerShopee = () => item.variacao_id ? shopee.lerModelos(destino.conta, item.anuncio_id) : shopee.lerItens(destino.conta, [item.anuncio_id])
      const antesSh = (await lerShopee()).get(item.variacao_id || item.anuncio_id)
      if (!antesSh || antesSh.quantidade === null) return concluir('erro', { alvo, erro: `item${item.variacao_id ? '/variação' : ''} não encontrado na loja Shopee ${destino.conta.nickname} — envio não feito` })
      const r = await shopee.enviar(destino.conta, item.anuncio_id, item.variacao_id || null, alvo)
      let confirmada = null
      try {
        const mapa = item.variacao_id ? await shopee.lerModelos(destino.conta, item.anuncio_id) : await shopee.lerItens(destino.conta, [item.anuncio_id])
        const v = mapa.get(item.variacao_id || item.anuncio_id); confirmada = v ? v.quantidade : null
      } catch (e) { /* leitura de confirmação falhou: o envio continua válido; a conferência mostra depois */ }
      return concluir('ok', { alvo, enviada: alvo, confirmada, http: r.http, resposta: r.resposta,
        erro: confirmada !== null && confirmada !== alvo ? `enviado ${alvo}, a Shopee mostra ${confirmada} — conferir` : null })
    } catch (e) {
      const erro = e instanceof ErroPlataforma ? e : new ErroPlataforma(e.message, { tipo: 'temporario' })
      if (erro.tipo === 'temporario' && item.tentativas < MAX_TENTATIVAS) {
        const atraso = ESPERAS[Math.min(Math.max(item.tentativas - 1, 0), ESPERAS.length - 1)]
        return concluir('erro_temporario', { alvo, erro: `${erro.message} — nova tentativa em ${Math.round(atraso / 60)} min`, atraso, http: erro.http, resposta: erro.resposta })
      }
      return concluir('erro', { alvo, erro: erro.message, http: erro.http, resposta: erro.resposta })
    }
  }

  let processando = false
  async function processarFila({ limite = 20 } = {}) {
    if (processando) return { ignorado: true }
    processando = true
    const resumo = { processados: 0, porStatus: {} }
    try {
      const itens = await rpc('estoque_fila_reservar', { p_limite: limite }) || []
      for (const item of itens) {
        let st
        try { st = await processarItem(item) } catch (e) {
          log(`❌ [ESTOQUE] item da fila ${item.id}: ${e.message}`)
          try { st = await rpc('estoque_fila_concluir', { p_id: item.id, p_versao: item.versao, p_status: 'erro_temporario', p_alvo: null, p_enviada: null, p_confirmada: null, p_erro: `falha interna: ${e.message}`, p_atraso_segundos: 300 }) } catch { st = 'erro_temporario' }
        }
        resumo.processados++; resumo.porStatus[st] = (resumo.porStatus[st] || 0) + 1
        await dormir(esperaEntreEnviosMs)
      }
      return resumo
    } finally { processando = false }
  }

  // ── Conferência (botão "Sincronizar Estoque Agora" e rotina automática) — SÓ LÊ as plataformas ──────────
  async function conferir({ empresaId, skus = null, plataformas = ['mercadolivre', 'shopee'], registrar = true, progresso = () => {} }) {
    const filtroSku = Array.isArray(skus) && skus.length ? new Set(skus.map(String)) : null
    const produtos = new Map()
    for (let de = 0; ; de += 1000) { // products pode ter mais de 1000 linhas
      const lote = await q(sb.from('products').select('sku, name, estoque_atual').eq('empresa_id', empresaId).range(de, de + 999), 'produtos')
      for (const p of (lote || [])) { if (!produtos.has(p.sku)) produtos.set(p.sku, p); else produtos.set(p.sku, { ...p, duplicado: true }) }
      if (!lote || lote.length < 1000) break
    }
    const contas = await q(sb.from('ml_accounts').select('id, nickname, ml_user_id, platform, active, empresa_id, access_token, refresh_token, expires_at').eq('empresa_id', empresaId), 'contas')
    const fila = await q(sb.from('estoque_sync_fila').select('destino, conta_ref, anuncio_id, variacao_id, status, quantidade_enviada, enviado_em, ultimo_erro, atualizado_em').eq('empresa_id', empresaId), 'fila')
    const cfgAgora = await lerConfig(empresaId)
    const filaPor = new Map((fila || []).map((f) => [`${f.destino}:${f.conta_ref}:${f.anuncio_id}:${f.variacao_id}`, f]))
    const abertas = await q(sb.from('estoque_divergencias').select('id, chave').eq('empresa_id', empresaId).not('chave', 'is', null).not('resolvido', 'is', true), 'divergências abertas')
    const chavesAbertas = new Set((abertas || []).map((d) => d.chave))
    const linhas = []

    const avaliar = async (base, leitura) => {
      const p = produtos.get(base.sku)
      const chave = `${base.destino}:${base.conta_ref}:${base.anuncio_id}:${base.variacao_id}`
      const f = filaPor.get(chave)
      const envioAgora = decidirEnvio(cfgAgora, base.sku)
      const linha = { ...base, chave, nome: p ? p.name : null, tmp10: p ? p.estoque_atual : null, plataforma_qtd: leitura && !leitura.erro ? leitura.quantidade : null,
        fila_status: f ? f.status : null, fila_erro: f ? f.ultimo_erro : null, fila_atualizado_em: f ? f.atualizado_em : null,
        // decisão com a configuração de AGORA (o texto da fila é do último processamento e pode ser de antes do piloto)
        envio_agora: envioAgora,
        fila_desatualizada: !!(f && f.status === 'simulado' && envioAgora.real) }
      if (!p) linha.situacao = 'sem_produto'
      else if (p.duplicado) linha.situacao = 'sku_duplicado'
      else if (p.estoque_atual === null || p.estoque_atual === undefined) linha.situacao = 'sem_estoque_oficial'
      else if (base.sincronizar === false) linha.situacao = 'desligado'
      else if (!leitura || leitura.erro || leitura.quantidade === null) { linha.situacao = 'erro_leitura'; linha.erro = leitura ? leitura.erro : 'sem leitura' }
      else if (leitura.variacoes > 0) { linha.situacao = 'variacao_ml'; linha.erro = `anúncio com ${leitura.variacoes} variação(ões) no ML — envio bloqueado (PRECISA CONFIRMAR)` }
      else if (f && ['pendente', 'enviando', 'erro_temporario'].includes(f.status)) linha.situacao = 'em_envio'
      else if (leitura.quantidade === Math.max(0, p.estoque_atual)) {
        linha.situacao = 'igual'
        if (registrar && chavesAbertas.has(chave)) await rpc('estoque_divergencia_registrar', { p_empresa: empresaId, p_sku: base.sku, p_chave: chave, p_plataforma: base.destino, p_conta: base.conta_ref, p_anuncio: base.anuncio_id, p_variacao: base.variacao_id, p_tmp10: Math.max(0, p.estoque_atual), p_plataforma_qtd: leitura.quantidade })
      } else if (await rpc('estoque_anuncio_tem_full', { p_empresa: empresaId, p_anuncio: base.anuncio_id, p_dias: 90 })) linha.situacao = 'full'
      else {
        linha.situacao = 'diferente'
        if (registrar) {
          const d = await rpc('estoque_divergencia_registrar', { p_empresa: empresaId, p_sku: base.sku, p_chave: chave, p_plataforma: base.destino, p_conta: base.conta_ref, p_anuncio: base.anuncio_id, p_variacao: base.variacao_id, p_tmp10: Math.max(0, p.estoque_atual), p_plataforma_qtd: leitura.quantidade })
          linha.divergencia_id = d && d.id; linha.ocorrencias = d && d.ocorrencias
        }
      }
      linhas.push(linha)
    }

    if (plataformas.includes('mercadolivre')) {
      const links = await q(sb.from('product_ml_links').select('sku, account_nickname, ml_item_id, ml_user_id, sincronizar').eq('empresa_id', empresaId), 'vínculos ML')
      const doFiltro = (links || []).filter((l) => l.ml_item_id && (!filtroSku || filtroSku.has(l.sku)))
      const porConta = new Map()
      for (const l of doFiltro) {
        const conta = (contas || []).find((c) => !ehShopee(c) && c.active === true && (l.ml_user_id ? String(c.ml_user_id) === String(l.ml_user_id) : c.nickname === l.account_nickname))
        const base = { sku: l.sku, destino: 'mercadolivre', conta_ref: l.ml_user_id ? String(l.ml_user_id) : `nick:${l.account_nickname}`, conta_nome: l.account_nickname, anuncio_id: String(l.ml_item_id), variacao_id: '', sincronizar: l.sincronizar }
        if (!conta) { await avaliar(base, { erro: 'conta do anúncio não conectada/ativa nesta empresa' }); continue }
        if (!porConta.has(conta.id)) porConta.set(conta.id, { conta, itens: [] })
        porConta.get(conta.id).itens.push(base)
      }
      for (const { conta, itens } of porConta.values()) {
        for (let i = 0; i < itens.length; i += 20) {
          const lote = itens.slice(i, i + 20)
          let mapa
          try { mapa = await ml.lerAnuncios(conta, [...new Set(lote.map((x) => x.anuncio_id))]) } catch (e) { mapa = null; for (const b of lote) await avaliar(b, { erro: e.message }) }
          if (mapa) for (const b of lote) await avaliar(b, mapa.get(b.anuncio_id))
          progresso(linhas.length)
          await dormir(esperaEntreEnviosMs)
        }
      }
    }
    if (plataformas.includes('shopee')) {
      const links = await q(sb.from('product_shopee_links').select('sku, shop_id, item_id, model_id, sincronizar').eq('empresa_id', empresaId), 'vínculos Shopee')
      const doFiltro = (links || []).filter((l) => l.item_id && (!filtroSku || filtroSku.has(l.sku)))
      const porLoja = new Map()
      for (const l of doFiltro) {
        const conta = (contas || []).find((c) => ehShopee(c) && c.active === true && String(c.ml_user_id) === String(l.shop_id))
        const base = { sku: l.sku, destino: 'shopee', conta_ref: String(l.shop_id), conta_nome: conta ? conta.nickname : String(l.shop_id), anuncio_id: String(l.item_id), variacao_id: l.model_id ? String(l.model_id) : '', sincronizar: l.sincronizar }
        if (!conta) { await avaliar(base, { erro: 'loja Shopee não conectada/ativa nesta empresa' }); continue }
        if (!porLoja.has(conta.id)) porLoja.set(conta.id, { conta, simples: [], variacoes: new Map() })
        const g = porLoja.get(conta.id)
        if (base.variacao_id) { if (!g.variacoes.has(base.anuncio_id)) g.variacoes.set(base.anuncio_id, []); g.variacoes.get(base.anuncio_id).push(base) } else g.simples.push(base)
      }
      for (const { conta, simples, variacoes } of porLoja.values()) {
        for (let i = 0; i < simples.length; i += 20) {
          const lote = simples.slice(i, i + 20)
          let mapa
          try { mapa = await shopee.lerItens(conta, [...new Set(lote.map((x) => x.anuncio_id))]) } catch (e) { mapa = null; for (const b of lote) await avaliar(b, { erro: e.message }) }
          if (mapa) for (const b of lote) await avaliar(b, mapa.get(b.anuncio_id) || { erro: 'item não devolvido pela Shopee' })
          progresso(linhas.length); await dormir(esperaEntreEnviosMs)
        }
        for (const [itemId, bases] of variacoes) {
          let mapa
          try { mapa = await shopee.lerModelos(conta, itemId) } catch (e) { mapa = null; for (const b of bases) await avaliar(b, { erro: e.message }) }
          if (mapa) for (const b of bases) await avaliar(b, mapa.get(b.variacao_id) || { erro: 'variação não devolvida pela Shopee' })
          progresso(linhas.length); await dormir(esperaEntreEnviosMs)
        }
      }
    }
    const resumo = {}
    for (const l of linhas) resumo[l.situacao] = (resumo[l.situacao] || 0) + 1
    const ordem = { diferente: 0, erro_leitura: 1, em_envio: 2, full: 3, variacao_ml: 4, sem_estoque_oficial: 5, sem_produto: 6, sku_duplicado: 7, desligado: 8, igual: 9 }
    linhas.sort((a, b) => (ordem[a.situacao] ?? 9) - (ordem[b.situacao] ?? 9) || String(a.sku).localeCompare(String(b.sku)))
    return { total: linhas.length, resumo, linhas }
  }

  // Conferência em segundo plano (uma por empresa)
  const trabalhos = new Map()
  function iniciarConferencia(empresaId, opcoes = {}) {
    const atual = trabalhos.get(empresaId)
    if (atual && atual.rodando) return atual
    const t = { rodando: true, iniciado_em: new Date().toISOString(), terminado_em: null, lidos: 0, resultado: null, erro: null }
    trabalhos.set(empresaId, t)
    conferir({ ...opcoes, empresaId, progresso: (n) => { t.lidos = n } })
      .then((r) => { t.resultado = { ...r, linhas: r.linhas.slice(0, 5000) } })
      .catch((e) => { t.erro = e.message; log(`❌ [ESTOQUE] conferência ${empresaId}: ${e.message}`) })
      .finally(() => { t.rodando = false; t.terminado_em = new Date().toISOString() })
    return t
  }
  const statusConferencia = (empresaId) => trabalhos.get(empresaId) || { rodando: false, resultado: null }

  // Rotina automática: confere todas as empresas que têm vínculo (só lê; divergência sem duplicar)
  async function conferirTodas({ plataformas }) {
    const vinc = plataformas.includes('shopee') && plataformas.length === 1 ? 'product_shopee_links' : 'product_ml_links'
    const ids = new Set()
    for (let de = 0; ; de += 1000) {
      const lote = await q(sb.from(vinc).select('empresa_id').range(de, de + 999), 'empresas com vínculo')
      for (const l of (lote || [])) if (l.empresa_id) ids.add(l.empresa_id)
      if (!lote || lote.length < 1000) break
    }
    const res = {}
    for (const id of ids) {
      try { const r = await conferir({ empresaId: id, plataformas, registrar: true }); res[id] = r.resumo } catch (e) { res[id] = { erro: e.message }; log(`❌ [ESTOQUE] conferência automática ${id}: ${e.message}`) }
    }
    return res
  }

  // ── Ações explícitas ────────────────────────────────────────────────────────────────────────────────────
  // ── Sincronizar Agora: PRÉVIA (o que será processado) e ENVIO para a fila em lote ──────────────────────
  // Regra central mantida: o SKU é a unidade; TODOS os anúncios vinculados ao SKU recebem o mesmo número do TMP10.
  function listaDeSkus(skus) {
    const lista = [...new Set((Array.isArray(skus) ? skus : []).map((s) => String(s).trim()).filter(Boolean))]
    if (!lista.length) throw Object.assign(new Error('Escolha pelo menos um produto.'), { status: 400 })
    if (lista.length > 200) throw Object.assign(new Error('No máximo 200 produtos por vez.'), { status: 400 })
    return lista
  }
  async function lerTodos(montar, contexto) { // pagina de 1000 em 1000 (limite padrão da API do banco)
    const todos = []
    for (let de = 0; ; de += 1000) {
      const lote = await q(montar().range(de, de + 999), contexto)
      todos.push(...(lote || []))
      if (!lote || lote.length < 1000) return todos
    }
  }
  // Destinos (anúncio/variação) dos SKUs — MESMA regra da fila: ML com ml_item_id; Shopee com item_id e shop_id;
  // o mesmo anúncio ligado a 2 SKUs conta UMA vez (fica com o 1º SKU em ordem alfabética, como no banco).
  async function destinosDosSkus(empresaId, lista) {
    const ml = await lerTodos(() => sb.from('product_ml_links').select('sku, account_nickname, ml_item_id, ml_user_id, sincronizar, ml_variation_id').eq('empresa_id', empresaId).in('sku', lista), 'vínculos ML')
    const sh = await lerTodos(() => sb.from('product_shopee_links').select('sku, shop_id, item_id, model_id, sincronizar').eq('empresa_id', empresaId).in('sku', lista), 'vínculos Shopee')
    const porChave = new Map()
    const add = (d) => { const atual = porChave.get(d.chave); if (!atual || String(d.sku) < String(atual.sku)) porChave.set(d.chave, d) }
    for (const l of ml) {
      if (!l.ml_item_id) continue
      const conta_ref = l.ml_user_id ? String(l.ml_user_id) : `nick:${l.account_nickname}`
      add({ sku: l.sku, destino: 'mercadolivre', conta_ref, conta_nome: l.account_nickname, anuncio_id: String(l.ml_item_id), variacao_id: '', sincronizar: l.sincronizar, ml_variation_id: l.ml_variation_id,
        chave: `mercadolivre:${conta_ref}:${l.ml_item_id}:` })
    }
    for (const l of sh) {
      if (!l.item_id || !l.shop_id) continue
      const variacao_id = l.model_id ? String(l.model_id) : ''
      add({ sku: l.sku, destino: 'shopee', conta_ref: String(l.shop_id), anuncio_id: String(l.item_id), variacao_id, sincronizar: l.sincronizar,
        chave: `shopee:${l.shop_id}:${l.item_id}:${variacao_id}` })
    }
    return [...porChave.values()]
  }

  // PRÉVIA: só LÊ (banco + resultado da última conferência). Não grava nada, não chama ML/Shopee.
  async function previa({ empresaId, skus }) {
    const lista = listaDeSkus(skus)
    const destinos = await destinosDosSkus(empresaId, lista)
    const produtos = new Map()
    for (const p of await lerTodos(() => sb.from('products').select('sku, estoque_atual').eq('empresa_id', empresaId).in('sku', lista), 'produtos')) {
      produtos.set(p.sku, produtos.has(p.sku) ? { duplicado: true } : p)
    }
    const contas = await q(sb.from('ml_accounts').select('nickname, ml_user_id, platform, active').eq('empresa_id', empresaId), 'contas')
    let full = new Set()
    try { full = new Set(((await rpc('estoque_anuncios_full', { p_empresa: empresaId, p_dias: 90 })) || []).map((x) => String(typeof x === 'object' && x !== null ? Object.values(x)[0] : x))) }
    catch (e) { log(`[ESTOQUE] prévia sem a lista de Full (migração 22 aplicada?): ${e.message}`) }
    const conf = statusConferencia(empresaId)
    const situacaoConf = new Map(((conf.resultado && conf.resultado.linhas) || []).map((l) => [l.chave, l.situacao]))
    const contaAtiva = (d) => (contas || []).some((c) => c.active === true && (d.destino === 'shopee'
      ? c.platform === 'shopee' && String(c.ml_user_id) === d.conta_ref
      : c.platform !== 'shopee' && (d.conta_ref.startsWith('nick:') ? c.nickname === d.conta_ref.slice(5) : String(c.ml_user_id) === d.conta_ref)))
    const categorias = { diferente: 0, igual: 0, bloqueado: 0, erro: 0, em_envio: 0, nao_conferido: 0 }
    const cfgAgora = await lerConfig(empresaId)
    let envioReal = 0, envioSimulado = 0
    const motivosBloqueio = {}
    const porSku = new Map(lista.map((sku) => [sku, { sku, anuncios: 0 }]))
    for (const d of destinos) {
      const p = produtos.get(d.sku)
      let cat, motivo = null
      if (!p) { cat = 'bloqueado'; motivo = 'produto não cadastrado' }
      else if (p.duplicado) { cat = 'bloqueado'; motivo = 'SKU duplicado' }
      else if (p.estoque_atual === null || p.estoque_atual === undefined) { cat = 'bloqueado'; motivo = 'sem estoque oficial no TMP10' }
      else if (d.sincronizar === false) { cat = 'bloqueado'; motivo = 'sincronização desligada no anúncio' }
      else if (full.has(d.anuncio_id)) { cat = 'bloqueado'; motivo = d.destino === 'shopee' ? 'FBS (Full da Shopee)' : 'Full' }
      else if (d.ml_variation_id) { cat = 'bloqueado'; motivo = 'variação no ML (precisa confirmar)' }
      else if (!contaAtiva(d)) { cat = 'bloqueado'; motivo = 'conta não conectada/ativa nesta empresa' }
      else if (d.destino === 'shopee' && shopee.ehSandbox() && !permitirSandbox) { cat = 'bloqueado'; motivo = 'Shopee em sandbox' }
      else {
        const sc = situacaoConf.get(d.chave)
        if (sc === 'diferente') cat = 'diferente'
        else if (sc === 'igual') cat = 'igual'
        else if (sc === 'erro_leitura') cat = 'erro'
        else if (sc === 'em_envio') cat = 'em_envio'
        else if (sc === 'full') { cat = 'bloqueado'; motivo = 'Full' }
        else if (sc === 'variacao_ml') { cat = 'bloqueado'; motivo = 'variação no ML (precisa confirmar)' }
        else if (sc) { cat = 'bloqueado'; motivo = sc }
        else cat = 'nao_conferido'
      }
      categorias[cat]++
      if (cat !== 'bloqueado') { if (decidirEnvio(cfgAgora, d.sku).real) envioReal++; else envioSimulado++ }
      if (motivo) motivosBloqueio[motivo] = (motivosBloqueio[motivo] || 0) + 1
      if (porSku.has(d.sku)) porSku.get(d.sku).anuncios++
    }
    const semAnuncio = [...porSku.values()].filter((x) => x.anuncios === 0).map((x) => x.sku)
    return {
      produtos: lista.length, produtos_com_anuncio: lista.length - semAnuncio.length, sem_anuncio: semAnuncio.slice(0, 50),
      anuncios: destinos.length, categorias, motivos_bloqueio: motivosBloqueio,
      // até quantos podem receber o número: todos menos os bloqueados (Full, conta, variação ML...). Os com "erro" na
      // última leitura entram na fila e são lidos de novo no envio; se a leitura do ML falhar, NÃO enviam.
      receberao_envio: destinos.length - categorias.bloqueado,
      envio_real: envioReal, envio_simulado: envioSimulado, // dos que podem receber: quantos de verdade x simulação (modo/piloto de AGORA)
      conferencia_em: conf.terminado_em || null, config: cfgAgora, envio_habilitado: envioHabilitado()
    }
  }

  // ENVIO para a fila: uma operação no banco para todos os SKUs (migração 22). Sem a 22, grava um a um como antes.
  async function sincronizar({ empresaId, skus, usuarioId }) {
    const lista = listaDeSkus(skus)
    const motivo = `Sincronizar agora (usuário ${usuarioId || '-'})`
    let destinos = 0, modo = 'lote'
    const r = await sb.rpc('estoque_fila_enfileirar_lote', { p_empresa: empresaId, p_skus: lista, p_motivo: motivo })
    if (r && r.error) {
      const faltaFuncao = r.error.code === 'PGRST202' || /estoque_fila_enfileirar_lote/.test(String(r.error.message || '')) && /(does not exist|Could not find)/i.test(String(r.error.message || ''))
      if (!faltaFuncao) throw new Error(`rpc estoque_fila_enfileirar_lote: ${r.error.message}`)
      log('[ESTOQUE] migração 22 ainda não aplicada — fila gravada anúncio por anúncio (mais lento, mesmo resultado)')
      modo = 'um_a_um'
      for (const sku of lista) destinos += await enfileirarSku(empresaId, sku, motivo)
    } else destinos = (r && r.data && r.data.destinos) || 0
    agendarProcessamento()
    return { skus: lista.length, destinos, modo, config: await lerConfig(empresaId), envio_habilitado: envioHabilitado() }
  }

  async function resolverDivergencia({ empresaId, id, acao, usuarioId, estoqueEsperado }) {
    const d = await q(sb.from('estoque_divergencias').select('*').eq('id', id).eq('empresa_id', empresaId).maybeSingle(), 'divergência')
    if (!d || !d.chave) throw Object.assign(new Error('Divergência não encontrada.'), { status: 404 })
    if (d.resolvido === true) throw Object.assign(new Error('Esta divergência já foi resolvida.'), { status: 409 })
    let movimento = null
    if (acao === 'aceitar') {
      // a plataforma vira o número oficial — vira MOVIMENTO (rastreável) e o TMP10 envia para os outros anúncios
      movimento = await movimentar({ empresaId, sku: d.sku, tipo: 'definir', quantidade: Math.max(0, inteiro(d.estoque_ml)), origem: 'aceite_divergencia',
        motivo: `Aceito o número de ${ROTULO[d.plataforma] || d.plataforma} (anúncio ${d.anuncio_id})`, referencia: `divergencia:${d.id}`, usuarioId, processo: 'erp',
        esperado: estoqueEsperado === undefined || estoqueEsperado === null ? null : inteiro(estoqueEsperado) })
      if (movimento && movimento.erro === 'estoque_mudou') throw Object.assign(new Error(`O estoque do TMP10 mudou para ${movimento.anterior}. Confira de novo antes de aceitar.`), { status: 409 })
      if (movimento && !movimento.aplicado && !movimento.duplicado) throw Object.assign(new Error('Não foi possível aplicar: ' + (movimento.erro || 'erro')), { status: 409 })
    } else if (acao === 'enviar_tmp10') {
      await enfileirarSku(empresaId, d.sku, `Divergência ${d.id}: enviar número do TMP10`)
      agendarProcessamento()
    } else if (acao !== 'ignorar') throw Object.assign(new Error('Ação inválida.'), { status: 400 })
    await q(sb.from('estoque_divergencias').update({ resolvido: true, resolucao: acao === 'aceitar' ? 'aceito_valor_plataforma' : acao === 'enviar_tmp10' ? 'enviado_tmp10' : 'ignorada',
      resolvido_em: new Date().toISOString(), resolvido_por: usuarioId || null }).eq('id', d.id).eq('empresa_id', empresaId), 'resolver divergência')
    return { ok: true, movimento }
  }

  async function salvarConfig({ empresaId, modo, skusPiloto, confirmacao, usuarioId }) {
    if (!['desligado', 'piloto', 'ativo'].includes(modo)) throw Object.assign(new Error('Modo inválido.'), { status: 400 })
    const skus = [...new Set((Array.isArray(skusPiloto) ? skusPiloto : []).map((s) => String(s).trim()).filter(Boolean))]
    if (skus.length > 20) throw Object.assign(new Error('No máximo 20 SKUs no piloto.'), { status: 400 })
    if (modo === 'piloto' && !skus.length) throw Object.assign(new Error('Informe o SKU do piloto.'), { status: 400 })
    if (modo === 'ativo' && confirmacao !== 'LIBERAR PARA TODOS') throw Object.assign(new Error('Para liberar para todos, digite exatamente: LIBERAR PARA TODOS'), { status: 400 })
    await q(sb.from('estoque_sync_config').upsert({ empresa_id: empresaId, modo, skus_piloto: skus, atualizado_em: new Date().toISOString(), atualizado_por: usuarioId || null }, { onConflict: 'empresa_id' }), 'salvar config')
    log(`[ESTOQUE] empresa ${empresaId}: modo de envio = ${modo}${skus.length ? ' (' + skus.join(', ') + ')' : ''} por ${usuarioId || '-'}`)
    return lerConfig(empresaId)
  }

  async function painel(empresaId) {
    const config = await lerConfig(empresaId)
    const fila = await q(sb.from('estoque_sync_fila').select('id, sku, destino, conta_ref, anuncio_id, variacao_id, status, quantidade_alvo, quantidade_enviada, quantidade_confirmada, tentativas, proxima_tentativa, ultimo_erro, atualizado_em, enviado_em').eq('empresa_id', empresaId).order('atualizado_em', { ascending: false }).limit(300), 'fila')
    const contagem = {}
    for (const f of (fila || [])) contagem[f.status] = (contagem[f.status] || 0) + 1
    // Divergências ATUAIS (uma por anúncio, com chave): no máximo 300, as mais repetidas primeiro.
    // Filtro "aberta" = NOT (resolvido IS TRUE): usa o índice parcial da migração 23 e lê só as linhas novas,
    // nunca as ~220 mil antigas. Se mesmo assim falhar, o painel continua (fila, modo e movimentos) e avisa.
    let divergencias = [], divergenciasErro = null
    try {
      divergencias = await q(sb.from('estoque_divergencias').select('id, sku, plataforma, conta_ref, anuncio_id, variacao_id, estoque_tmp10, estoque_ml, diferenca, ocorrencias, detectado_em, atualizado_em').eq('empresa_id', empresaId).not('chave', 'is', null).not('resolvido', 'is', true).order('ocorrencias', { ascending: false }).limit(300), 'divergências')
    } catch (e) {
      divergenciasErro = 'Não foi possível carregar as divergências agora.'
      log(`[ESTOQUE] painel: ${e.message}`)
    }
    const movimentos = await q(sb.from('estoque_movimentos').select('id, sku, estoque_anterior, estoque_novo, quantidade, origem, motivo, aplicado, observacao, criado_em').eq('empresa_id', empresaId).order('criado_em', { ascending: false }).limit(50), 'movimentos')
    return { config, envio_habilitado: envioHabilitado(), shopee_sandbox: shopee.ehSandbox(), fila: fila || [], fila_contagem: contagem,
      divergencias: divergencias || [], divergencias_erro: divergenciasErro, divergencias_legado_abertas: await contarLegado(empresaId), movimentos: movimentos || [] }
  }

  // Quantidade de divergências ANTIGAS (sem chave, gravadas pela rotina antiga) ainda abertas — só informativo.
  // Não muda mais (a rotina antiga parou), então é contada no máximo 1 vez por hora por empresa, e nunca
  // derruba o painel: se a contagem falhar, mostra o último número conhecido (ou nada).
  const cacheLegado = new Map()
  async function contarLegado(empresaId) {
    const c = cacheLegado.get(empresaId)
    if (c && Date.now() - c.em < 60 * 60 * 1000) return c.valor
    try {
      const r = await sb.from('estoque_divergencias').select('id', { count: 'exact', head: true }).eq('empresa_id', empresaId).is('chave', null).not('resolvido', 'is', true)
      if (r && r.error) throw new Error(r.error.message)
      cacheLegado.set(empresaId, { valor: r.count, em: Date.now() })
      return r.count
    } catch (e) {
      log(`[ESTOQUE] painel: contagem das divergências antigas indisponível: ${e.message}`)
      if (c) { cacheLegado.set(empresaId, { valor: c.valor, em: Date.now() - 50 * 60 * 1000 }); return c.valor } // tenta de novo em ~10 min
      return null
    }
  }

  async function movimentosDoSku(empresaId, sku) {
    return q(sb.from('estoque_movimentos').select('*').eq('empresa_id', empresaId).eq('sku', String(sku)).order('criado_em', { ascending: false }).limit(200), 'movimentos do SKU')
  }

  async function liberarPausa({ empresaId, filaId }) {
    const f = await q(sb.from('estoque_sync_fila').select('id, status').eq('id', filaId).eq('empresa_id', empresaId).maybeSingle(), 'fila')
    if (!f) throw Object.assign(new Error('Item da fila não encontrado.'), { status: 404 })
    await q(sb.from('estoque_sync_fila').update({ status: 'pendente', tentativas: 0, proxima_tentativa: new Date().toISOString(), ultimo_erro: null, atualizado_em: new Date().toISOString() }).eq('id', filaId).eq('empresa_id', empresaId), 'liberar')
    agendarProcessamento()
    return { ok: true }
  }

  return { movimentar, registrarVenda, registrarCancelamento, ajustar, enfileirarSku, processarMovimentosPendentes, processarFila, processarItem,
    conferir, iniciarConferencia, statusConferencia, conferirTodas, previa, sincronizar, resolverDivergencia, salvarConfig, lerConfig, painel,
    movimentosDoSku, liberarPausa, agendarProcessamento }
}

module.exports = { criarServicoEstoque, ESPERAS, MAX_TENTATIVAS, LIMITE_LOOP }
