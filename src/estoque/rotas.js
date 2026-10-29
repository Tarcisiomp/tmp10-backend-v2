// Rotas /api/estoque/* — Estoque Central. Sempre com sessão de ADMINISTRADOR; a empresa vem SEMPRE da sessão
// (qualquer empresa_id enviado pelo navegador é ignorado). Funcionário e vendedor não alteram estoque por aqui.
const express = require('express')
const VERSAO_ESTOQUE = '2026-10-29-estoque-full'

function criarRotasEstoque({ sb, estoque, autenticar, exigirPapel, log = console.log }) {
  const router = express.Router()
  // empresa bloqueada/inativa/cancelada não usa (mesma regra da Central e do Super Admin)
  async function empresaComAcesso(req, res, next) {
    try {
      const { data, error } = await sb.from('empresas').select('id, status').eq('id', req.empresaId).maybeSingle()
      if (error) throw new Error(error.message)
      if (!data || ['bloqueado', 'inativo', 'cancelado'].includes(data.status)) return res.status(403).json({ ok: false, error: 'O acesso da sua empresa ao TMP10 está suspenso.' })
      next()
    } catch (e) {
      log(`[ESTOQUE] não foi possível conferir a empresa ${req.empresaId}: ${e.message}`)
      res.status(500).json({ ok: false, error: 'Não foi possível verificar seu acesso agora.' })
    }
  }
  const admin = [autenticar, empresaComAcesso, exigirPapel('admin')]

  // Versão do módulo de estoque publicada (SEM login; não expõe dados): serve para conferir, depois do deploy, se o
  // Railway está rodando o código novo — antes de publicar a interface. commit = RAILWAY_GIT_COMMIT_SHA (variável do Railway).
  router.get('/api/estoque/versao', (req, res) => res.json({ ok: true, modulo: 'estoque', versao: VERSAO_ESTOQUE, agrupamento: true,
    agrupamento_produtos: true, estoque_full_por_anuncio: true, commit: process.env.RAILWAY_GIT_COMMIT_SHA ? String(process.env.RAILWAY_GIT_COMMIT_SHA).slice(0, 7) : null }))
  const responder = (fn) => async (req, res) => {
    try {
      const r = await fn(req, res)
      if (!res.headersSent) res.json({ ok: true, ...r })
    } catch (e) {
      const status = e.status || 500
      if (status >= 500) log(`[ESTOQUE] erro em ${req.method} ${req.path} (empresa ${req.empresaId}): ${e.message}`)
      res.status(status).json({ ok: false, error: status >= 500 ? 'Não foi possível concluir agora. Tente de novo em instantes.' : e.message, ...(e.atual !== undefined ? { atual: e.atual } : {}), ...(e.previa ? { previa: e.previa } : {}) })
    }
  }
  const corpo = (req) => req.body || {}

  // Painel: modo de envio, fila, divergências atuais (uma por anúncio), últimos movimentos
  router.get('/api/estoque/painel', ...admin, responder(async (req) => estoque.painel(req.empresaId)))

  // Ajuste manual (substitui a gravação direta do navegador em products.estoque_atual)
  router.post('/api/estoque/ajustar', ...admin, responder(async (req) => {
    const b = corpo(req)
    const r = await estoque.ajustar({ empresaId: req.empresaId, sku: b.sku, novoEstoque: b.novo_estoque, estoqueEsperado: b.estoque_esperado,
      motivo: b.motivo, usuarioId: req.usuario.id, idOperacao: b.id_operacao })
    return { movimento: r }
  }))

  // Diagnóstico Shopee (só lê): TMP10 × Shopee (disponível, reserva de promoção, promoções), fila e últimas tentativas
  router.get('/api/estoque/shopee/diagnostico', ...admin, responder(async (req) => ({ diagnostico: await estoque.diagnosticoShopee(req.empresaId, String(req.query.sku || '')) })))
  // Tentar 1 vez (Shopee): recoloca só este item na fila, com todas as proteções (piloto, reserva, Full, conta)
  router.post('/api/estoque/shopee/tentar', ...admin, responder(async (req) => estoque.tentarShopeeUmaVez({ empresaId: req.empresaId, filaId: String(corpo(req).fila_id || '') })))

  // ── Ajuste em massa Marketplace → TMP10 (1ª versão: Mercado Livre) ──────────────────────────────────────────────
  // Lista da tela (só banco) · Simular (só lê ML; grava SÓ a auditoria) · Executar/retomar (estoque_movimentar) · Situação
  // contas: uma ou várias contas do ML (?contas=111,222 · corpo { contas: [...] }); "conta" (uma) continua aceito
  // Ajuste em massa (ML e Shopee → TMP10). Contas no formato 'ml:<id>' / 'sh:<shop_id>' (número puro = conta do ML).
  const contasDoCorpo = (b) => (Array.isArray(b.contas) ? b.contas.map(String).slice(0, 100) : null)
  const todosDoCorpo = (b) => (b.todos && typeof b.todos === 'object'
    ? { filtro: ['todos', 'divergencia', 'sem_divergencia'].includes(b.todos.filtro) ? b.todos.filtro : 'todos', busca: String(b.todos.busca || '').slice(0, 200),
        excluir: Array.isArray(b.todos.excluir) ? b.todos.excluir.map(String) : [] }
    : null)
  router.get('/api/estoque/ajuste-massa/itens', ...admin, responder(async (req) => estoque.ajusteMassa.itens({ empresaId: req.empresaId,
    contaRef: String(req.query.conta || ''), contasRef: req.query.contas ? String(req.query.contas) : null })))
  router.post('/api/estoque/ajuste-massa/simular', ...admin, responder(async (req) => {
    const b = corpo(req)
    return estoque.ajusteMassa.iniciarSimulacao({ empresaId: req.empresaId, usuarioId: req.usuario.id, contaRef: b.conta, contasRef: contasDoCorpo(b),
      skus: Array.isArray(b.skus) ? b.skus : null, todos: todosDoCorpo(b) })
  }))
  router.post('/api/estoque/ajuste-massa/simular/retomar', ...admin, responder(async (req) => estoque.ajusteMassa.retomarSimulacao({ empresaId: req.empresaId, usuarioId: req.usuario.id,
    execucaoId: String(corpo(req).execucao_id || '') })))
  router.post('/api/estoque/ajuste-massa/executar', ...admin, responder(async (req) => estoque.ajusteMassa.iniciarExecucao({ empresaId: req.empresaId, usuarioId: req.usuario.id,
    execucaoId: String(corpo(req).execucao_id || '') })))
  router.get('/api/estoque/ajuste-massa/execucoes/:id', ...admin, responder(async (req) => ({ execucao: await estoque.ajusteMassa.status(req.empresaId, req.params.id) })))
  router.get('/api/estoque/ajuste-massa/execucoes/:id/itens', ...admin, responder(async (req) => estoque.ajusteMassa.itensDaExecucao(req.empresaId, req.params.id, {
    pagina: Number(req.query.pagina) || 1, porPagina: Math.min(Number(req.query.por_pagina) || 100, 500), situacao: String(req.query.situacao || 'todos') })))
  // 🔗 Agrupar anúncios por produto principal (só admin; empresa SEMPRE da sessão; decisão manual com prévia + confirmação)
  const listaStr = (v, max) => (Array.isArray(v) ? v.map(String).slice(0, max) : [])
  router.get('/api/estoque/agrupamento/produtos', ...admin, responder(async (req) => estoque.agrupamento.produtos({ empresaId: req.empresaId, busca: String(req.query.busca || '').slice(0, 120) })))
  router.get('/api/estoque/agrupamento/anuncios', ...admin, responder(async (req) => estoque.agrupamento.anuncios({ empresaId: req.empresaId,
    plataforma: ['mercadolivre', 'shopee'].includes(req.query.plataforma) ? req.query.plataforma : '', conta: String(req.query.conta || '').slice(0, 80), busca: String(req.query.busca || '').slice(0, 120),
    principal: String(req.query.principal || '').slice(0, 120), pagina: Number(req.query.pagina) || 1, porPagina: Number(req.query.por_pagina) || 100 })))
  router.post('/api/estoque/agrupamento/ao-vivo', ...admin, responder(async (req) => estoque.agrupamento.aoVivo({ empresaId: req.empresaId, chaves: listaStr(corpo(req).chaves, 51) })))
  router.get('/api/estoque/agrupamento/grupos', ...admin, responder(async (req) => estoque.agrupamento.listarGrupos({ empresaId: req.empresaId })))
  router.get('/api/estoque/agrupamento/grupo', ...admin, responder(async (req) => estoque.agrupamento.detalheGrupo({ empresaId: req.empresaId, produtoSku: String(req.query.sku || '') })))
  router.post('/api/estoque/agrupamento/previa', ...admin, responder(async (req) => ({ previa: await estoque.agrupamento.previa({ empresaId: req.empresaId,
    produtoSku: String(corpo(req).produto_sku || ''), adicionar: listaStr(corpo(req).adicionar, 501), remover: Array.isArray(corpo(req).remover) ? corpo(req).remover.slice(0, 501) : [] }) })))
  // Tela Produtos → "Agrupar selecionados": anúncios vinculados aos PRODUTOS selecionados (só leitura)
  router.post('/api/estoque/agrupamento/produtos-anuncios', ...admin, responder(async (req) => estoque.agrupamento.produtosAnuncios({ empresaId: req.empresaId, skus: listaStr(corpo(req).skus, 201) })))
  router.post('/api/estoque/agrupamento/confirmar', ...admin, responder(async (req) => estoque.agrupamento.confirmar({ empresaId: req.empresaId, usuarioId: req.usuario.id,
    produtoSku: String(corpo(req).produto_sku || ''), adicionar: listaStr(corpo(req).adicionar, 501), remover: Array.isArray(corpo(req).remover) ? corpo(req).remover.slice(0, 501) : [],
    conferido: corpo(req).conferido === true, assinatura: String(corpo(req).assinatura || ''), operacaoId: String(corpo(req).operacao_id || ''),
    produtos: listaStr(corpo(req).produtos, 201), origem: String(corpo(req).origem || '') })))

  // 📊 Estoque NORMAL × FULL por anúncio (ML). Lista: só banco · Consultar Full: só GET no ML, grava só as tabelas do Full
  router.get('/api/estoque/full/anuncios', ...admin, responder(async (req) => estoque.full.saldos({ empresaId: req.empresaId, conta: String(req.query.conta || '').slice(0, 80),
    busca: String(req.query.busca || '').slice(0, 120), situacaoFull: ['pendente', 'atualizado', 'erro', 'indisponivel', 'sem_full'].includes(req.query.situacao_full) ? req.query.situacao_full : '',
    pagina: Number(req.query.pagina) || 1, porPagina: Number(req.query.por_pagina) || 100 })))
  router.post('/api/estoque/full/consultar', ...admin, responder(async (req) => {
    const b = corpo(req)
    const t = await estoque.full.iniciarConsulta(req.empresaId, { contas: listaStr(b.contas, 100), chaves: listaStr(b.chaves, 5000), usuarioId: req.usuario.id })
    return { consulta: { rodando: t.rodando, iniciado_em: t.iniciado_em } }
  }))
  router.get('/api/estoque/full/consultar/status', ...admin, responder(async (req) => ({ consulta: estoque.full.statusConsulta(req.empresaId) })))
  router.get('/api/estoque/full/historico', ...admin, responder(async (req) => estoque.full.historico({ empresaId: req.empresaId, contaRef: String(req.query.conta || ''), anuncioId: String(req.query.anuncio || '') })))

  // Diagnóstico ML (SÓ LEITURA): quantidade atual de cada anúncio vinculado — GET /api/estoque/diagnostico-ml?skus=A,B
  router.get('/api/estoque/diagnostico-ml', ...admin, responder(async (req) => ({ diagnostico: await estoque.ajusteMassa.diagnosticoML({ empresaId: req.empresaId, skus: String(req.query.skus || '') }) })))

  // Histórico de um SKU
  router.get('/api/estoque/movimentos', ...admin, responder(async (req) => ({ movimentos: await estoque.movimentosDoSku(req.empresaId, String(req.query.sku || '')) })))

  // 🔄 Sincronizar Estoque Agora — passo 1: CONFERIR (só lê ML/Shopee e compara com o TMP10; não envia nada)
  router.post('/api/estoque/conferir', ...admin, responder(async (req) => {
    const b = corpo(req)
    const plataformas = Array.isArray(b.plataformas) && b.plataformas.length ? b.plataformas.filter((p) => ['mercadolivre', 'shopee'].includes(p)) : ['mercadolivre', 'shopee']
    const t = estoque.iniciarConferencia(req.empresaId, { skus: Array.isArray(b.skus) ? b.skus.slice(0, 500) : null, plataformas, registrar: true })
    return { conferencia: { rodando: t.rodando, iniciado_em: t.iniciado_em } }
  }))
  router.get('/api/estoque/conferir/status', ...admin, responder(async (req) => ({ conferencia: estoque.statusConferencia(req.empresaId) })))

  // Passo 2: SINCRONIZAR os produtos escolhidos (coloca na fila; respeita o modo desligado/piloto/ativo)
  // Passo 2a: PRÉVIA — "X produtos → Y anúncios" (diferentes / iguais / bloqueados / erro). Só lê, não grava nada.
  router.post('/api/estoque/sincronizar/previa', ...admin, responder(async (req) => ({ previa: await estoque.previa({ empresaId: req.empresaId, skus: corpo(req).skus }) })))

  router.post('/api/estoque/sincronizar', ...admin, responder(async (req) => estoque.sincronizar({ empresaId: req.empresaId, skus: corpo(req).skus, usuarioId: req.usuario.id })))

  // Divergência: aceitar o número da plataforma (vira movimento) | enviar o número do TMP10 | ignorar
  router.post('/api/estoque/divergencias/:id/resolver', ...admin, responder(async (req) => {
    const b = corpo(req)
    return estoque.resolverDivergencia({ empresaId: req.empresaId, id: req.params.id, acao: b.acao, usuarioId: req.usuario.id, estoqueEsperado: b.estoque_esperado })
  }))

  // Liberar um anúncio pausado por proteção contra loop / tentar de novo um erro
  router.post('/api/estoque/fila/:id/liberar', ...admin, responder(async (req) => estoque.liberarPausa({ empresaId: req.empresaId, filaId: req.params.id })))

  // Modo de envio da empresa: desligado | piloto (lista de SKUs) | ativo (exige confirmação escrita)
  router.get('/api/estoque/config', ...admin, responder(async (req) => ({ config: await estoque.lerConfig(req.empresaId) })))
  router.put('/api/estoque/config', ...admin, responder(async (req) => {
    const b = corpo(req)
    return { config: await estoque.salvarConfig({ empresaId: req.empresaId, modo: b.modo, skusPiloto: b.skus_piloto, confirmacao: b.confirmacao, usuarioId: req.usuario.id }) }
  }))

  // Qualquer outra rota /api/estoque/* (ex.: tela nova chamando um backend antigo): 404 em JSON com explicação,
  // em vez da página "Cannot GET" — a tela mostra a causa.
  router.all(/^\/api\/estoque\/.*/, (req, res) => res.status(404).json({ ok: false, codigo: 'rota_inexistente', versao: VERSAO_ESTOQUE,
    error: `Rota ${req.method} ${req.path} não existe neste backend (versão ${VERSAO_ESTOQUE}).` }))
  return router
}

module.exports = { criarRotasEstoque, VERSAO_ESTOQUE }
