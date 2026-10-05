// Fase 2 — proteção das rotas antigas do Mercado Livre / Shopee (achados A1–A4 da auditoria da Fase 1).
//
// Regra: ninguém sem sessão executa operação; a empresa vem SEMPRE da sessão (nunca do navegador);
// vendedor externo não dispara rotina de marketplace (P13: vendedor só vende).
// Ferramentas de administração da plataforma continuam funcionando com o cabeçalho X-Admin-Token.
const crypto = require('crypto')
const { tokensIguais } = require('../adminAuth')

function criarGuardaLegado({ adminToken, autenticar, log = console.warn }) {
  // sessão de usuário da empresa (admin ou funcionário, não vendedor externo) OU X-Admin-Token da plataforma
  function sessaoOuToken(req, res, next) {
    const recebido = req.get('x-admin-token')
    if (recebido) {
      if (adminToken && tokensIguais(recebido, adminToken)) { req.viaTokenAdmin = true; return next() }
      log(`[SEGURANCA] ${req.method} ${req.path} bloqueada (X-Admin-Token inválido)`)
      return res.status(403).json({ ok: false, error: 'Acesso restrito.' })
    }
    return autenticar(req, res, () => {
      if (req.usuario.is_vendedor_externo) return res.status(403).json({ ok: false, error: 'Você não tem permissão para esta ação.' })
      next()
    })
  }
  // só sessão (a operação é de UMA empresa e precisa saber qual): admin ou funcionário, não vendedor externo
  function sessaoOperacional(req, res, next) {
    return autenticar(req, res, () => {
      if (req.usuario.is_vendedor_externo) return res.status(403).json({ ok: false, error: 'Você não tem permissão para esta ação.' })
      next()
    })
  }
  // só administrador da empresa (conectar conta de marketplace)
  function sessaoAdmin(req, res, next) {
    return autenticar(req, res, () => {
      if (req.usuario.role !== 'admin' || req.usuario.is_vendedor_externo) return res.status(403).json({ ok: false, error: 'Só o administrador da empresa pode conectar contas.' })
      next()
    })
  }
  return { sessaoOuToken, sessaoOperacional, sessaoAdmin }
}

// ── "Ticket" assinado para o login do Mercado Livre / Shopee (A4) ──
// O navegador não manda cabeçalho de sessão quando abre a página de autorização; por isso o ERP pede antes,
// COM a sessão, um ticket assinado pelo backend dizendo: esta conta, desta empresa, válido por 15 minutos.
// O callback só aceita o ticket com assinatura válida — ninguém consegue ligar conta à empresa de outro.
function segredoOAuth(env = process.env) {
  const proprio = String(env.OAUTH_STATE_SECRET || '').trim()
  if (proprio.length >= 32) return proprio
  // sem variável própria: derivado da chave de serviço (que só o backend tem) — nunca sai do servidor
  return crypto.createHash('sha256').update('tmp10-oauth-state|' + String(env.SUPABASE_SERVICE_KEY || '')).digest('hex')
}
function criarTicket(dados, segredo, validadeSeg = 15 * 60) {
  const corpo = Buffer.from(JSON.stringify({ ...dados, exp: Math.floor(Date.now() / 1000) + validadeSeg })).toString('base64url')
  const assinatura = crypto.createHmac('sha256', segredo).update(corpo).digest('base64url')
  return `${corpo}.${assinatura}`
}
function lerTicket(ticket, segredo) {
  const [corpo, assinatura] = String(ticket || '').split('.')
  if (!corpo || !assinatura) return null
  const esperada = crypto.createHmac('sha256', segredo).update(corpo).digest('base64url')
  const a = Buffer.from(assinatura), b = Buffer.from(esperada)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let dados
  try { dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8')) } catch (e) { return null }
  if (!dados || typeof dados.exp !== 'number' || dados.exp < Math.floor(Date.now() / 1000)) return null
  if (!dados.empresaId) return null
  return dados
}

module.exports = { criarGuardaLegado, criarTicket, lerTicket, segredoOAuth }
