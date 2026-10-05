// Rotas /api/inteligencia/* — Central TMP10 (DRE, alertas, agentes, relatório, memória, assistente).
// Todas exigem sessão (Authorization: Bearer). A empresa vem SEMPRE da sessão (req.empresaId); qualquer
// empresa_id enviado pelo navegador é ignorado. Dados financeiros: só administrador da empresa.
// Vendedor externo: só /meu-desempenho, com os PRÓPRIOS números de venda (sem custo/lucro — regra P13).
const express = require('express')
const { criarServico } = require('./servico')
const { criarAssistente } = require('./assistente')

const EMPRESA_SEM_ACESSO = ['bloqueado', 'inativo', 'cancelado'] // mesma regra do Super Admin

function criarRotasInteligencia({ sb, autenticar, exigirPapel, envioPush = null, log = console.log, agora, limitePorMinuto = 30 }) {
  const router = express.Router()
  const servico = criarServico({ sb, envioPush, log, agora })
  const assistente = criarAssistente({ sb, servico })
  const soAdmin = exigirPapel('admin')
  const ultimaRodada = new Map()

  async function empresaComAcesso(req, res, next) {
    try {
      const { data, error } = await sb.from('empresas').select('id, status').eq('id', req.empresaId).maybeSingle()
      if (error) throw new Error(error.message)
      if (!data || EMPRESA_SEM_ACESSO.includes(data.status)) return res.status(403).json({ ok: false, error: 'O acesso da sua empresa ao TMP10 está suspenso.' })
      next()
    } catch (e) {
      log(`[INTELIGENCIA] não foi possível conferir a empresa ${req.empresaId}: ${e.message}`)
      res.status(500).json({ ok: false, error: 'Não foi possível verificar seu acesso agora.' })
    }
  }
  // Limite por usuário nas rotas que calculam (evita abuso): padrão 30 pedidos por minuto
  const janelas = new Map()
  function limitar(req, res, next) {
    const k = req.usuario.id, agoraMs = Date.now()
    const j = (janelas.get(k) || []).filter((t) => agoraMs - t < 60000)
    if (j.length >= limitePorMinuto) return res.status(429).json({ ok: false, error: 'Muitas consultas seguidas. Aguarde um minuto.' })
    j.push(agoraMs); janelas.set(k, j)
    if (janelas.size > 5000) for (const [kk, v] of janelas) if (!v.some((t) => agoraMs - t < 60000)) janelas.delete(kk)
    next()
  }
  const base = [autenticar, empresaComAcesso]
  const admin = [...base, soAdmin]
  const responder = (fn) => async (req, res) => {
    try {
      const r = await fn(req, res)
      if (!res.headersSent) res.json({ ok: true, ...r })
    } catch (e) {
      const status = e.status || 500
      if (status >= 500 && status !== 501 && status !== 503) log(`[INTELIGENCIA] erro em ${req.method} ${req.path} (empresa ${req.empresaId}): ${e.message}`)
      res.status(status).json({ ok: false, error: status === 500 ? 'Não foi possível concluir agora. Tente de novo em instantes.' : e.message })
    }
  }

  // DRE / lucro real
  router.get('/api/inteligencia/dre', ...admin, limitar, responder(async (req) => servico.calcularDRE(req.empresaId, req.query)))

  // Vendas do período uma a uma, já calculadas pelo MESMO serviço do DRE (usado pela tela Financeiro)
  router.get('/api/inteligencia/vendas', ...admin, limitar, responder(async (req) => servico.vendasDetalhadas(req.empresaId, req.query)))

  // Relatório diário (recalcula se tiver mais de 60 min)
  router.get('/api/inteligencia/relatorio', ...admin, limitar, responder(async (req) => servico.relatorioDoDia(req.empresaId)))

  // Rodar os agentes agora (máximo 1 vez por minuto por empresa)
  router.post('/api/inteligencia/agentes/rodar', ...admin, responder(async (req) => {
    const ult = ultimaRodada.get(req.empresaId) || 0
    if (Date.now() - ult < 60000) throw Object.assign(new Error('Aguarde um minuto para atualizar de novo.'), { status: 429 })
    ultimaRodada.set(req.empresaId, Date.now())
    const r = await servico.rodarAgentes(req.empresaId)
    return { relatorio: r.relatorio, alertas: r.alertas, agentes: r.agentes }
  }))

  // Central de alertas
  router.get('/api/inteligencia/alertas', ...admin, responder(async (req) => ({ alertas: await servico.alertas.listar(req.empresaId, { status: req.query.status || 'abertos', nivel: req.query.nivel }) })))
  for (const acao of ['lido', 'resolver', 'reabrir', 'assumir']) {
    router.post(`/api/inteligencia/alertas/:id/${acao}`, ...admin, responder(async (req) => {
      await servico.alertas.marcar(req.empresaId, req.params.id, req.usuario.id, acao, req.body && req.body.resolucao)
      return {}
    }))
  }

  // Configuração dos agentes
  router.get('/api/inteligencia/config', ...admin, responder(async (req) => ({ config: await servico.lerConfig(req.empresaId) })))
  router.put('/api/inteligencia/config', ...admin, responder(async (req) => ({ config: await servico.salvarConfig(req.empresaId, req.usuario.id, req.body || {}) })))

  // Memória da empresa
  router.get('/api/inteligencia/memoria', ...admin, responder(async (req) => ({ memoria: await servico.listarMemoria(req.empresaId) })))
  router.post('/api/inteligencia/memoria', ...admin, responder(async (req) => ({ item: await servico.criarMemoria(req.empresaId, req.usuario.id, req.body || {}) })))
  router.put('/api/inteligencia/memoria/:id', ...admin, responder(async (req) => { await servico.alterarMemoria(req.empresaId, req.params.id, req.body || {}); return {} }))
  router.delete('/api/inteligencia/memoria/:id', ...admin, responder(async (req) => { await servico.apagarMemoria(req.empresaId, req.params.id); return {} }))

  // Assistente (texto/voz) e ações com confirmação
  router.post('/api/inteligencia/perguntar', ...admin, limitar, responder(async (req) => {
    const p = String((req.body && req.body.pergunta) || '').slice(0, 300)
    return await assistente.perguntar(req.empresaId, req.usuario, p)
  }))
  router.post('/api/inteligencia/acoes/executar', ...admin, responder(async (req) => ({ resultado: await assistente.executar(req.empresaId, req.usuario, req.body || {}) })))

  // Vendedor: só os PRÓPRIOS números de venda (sem custo, sem lucro, sem dados de outros vendedores)
  router.get('/api/inteligencia/meu-desempenho', ...base, limitar, responder(async (req) => {
    const { data: vend, error } = await sb.from('revenda_vendedores').select('id, nome').eq('empresa_id', req.empresaId).eq('user_id', req.usuario.id).maybeSingle()
    if (error) throw new Error(error.message)
    if (!vend) return { vendedor: null, mensagem: 'Seu usuário não está ligado a um cadastro de vendedor.' }
    const periodo = ['hoje', 'ontem', 'semana', 'mes', 'ano'].includes(req.query.periodo) ? req.query.periodo : 'mes'
    const r = await servico.calcularDRE(req.empresaId, { periodo, marketplace: 'venda_externa', vendedor: vend.id, agrupar: 'dia' })
    return {
      vendedor: { nome: vend.nome }, periodo: r.periodo,
      resumo: { vendas: r.resumo.pedidos, faturamento: r.resumo.faturamento, ticket_medio: r.resumo.ticket_medio, comissao: r.resumo.comissao, produtos_vendidos: r.resumo.produtos_vendidos },
      por_dia: r.grupos.map((g) => ({ dia: g.chave, vendas: g.pedidos, faturamento: g.faturamento, comissao: g.comissao }))
    }
  }))

  return { router, servico }
}

module.exports = { criarRotasInteligencia }
