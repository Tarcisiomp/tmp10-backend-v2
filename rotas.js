// Rotas /api/estoque/* — Estoque Central. Sempre com sessão de ADMINISTRADOR; a empresa vem SEMPRE da sessão
// (qualquer empresa_id enviado pelo navegador é ignorado). Funcionário e vendedor não alteram estoque por aqui.
const express = require('express')

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
  const responder = (fn) => async (req, res) => {
    try {
      const r = await fn(req, res)
      if (!res.headersSent) res.json({ ok: true, ...r })
    } catch (e) {
      const status = e.status || 500
      if (status >= 500) log(`[ESTOQUE] erro em ${req.method} ${req.path} (empresa ${req.empresaId}): ${e.message}`)
      res.status(status).json({ ok: false, error: status >= 500 ? 'Não foi possível concluir agora. Tente de novo em instantes.' : e.message, ...(e.atual !== undefined ? { atual: e.atual } : {}) })
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

  return router
}

module.exports = { criarRotasEstoque }
