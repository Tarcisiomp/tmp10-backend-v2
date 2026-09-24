// Proteção das rotas de manutenção / faturamento / administração.
// Só passa quem enviar o cabeçalho  X-Admin-Token  igual à variável ADMIN_API_TOKEN.
// A comparação é feita em tempo constante (não dá pistas por tempo de resposta).
//
// ADMIN_ROUTES_MODE:
//   enforce (padrão) → bloqueia chamadas sem token válido (401/403)
//   report           → deixa passar, mas registra no log. Serve para descobrir, sem quebrar nada,
//                      se alguma tela (ex.: Super Admin) ainda chama essas rotas.

const crypto = require('crypto')

function tokensIguais(recebido, esperado) {
  const a = crypto.createHash('sha256').update(String(recebido)).digest()
  const b = crypto.createHash('sha256').update(String(esperado)).digest()
  return crypto.timingSafeEqual(a, b)
}

function criarExigirAdmin({ token, modo = 'enforce', log = console.warn }) {
  if (!token || String(token).length < 32) throw new Error('criarExigirAdmin: token inválido')
  return function exigirAdmin(req, res, next) {
    const recebido = req.get('x-admin-token')
    const ok = !!recebido && tokensIguais(recebido, token)
    if (ok) return next()
    const motivo = recebido ? 'token inválido' : 'sem token'
    if (modo === 'report') {
      log(`[SEGURANCA][report] ${req.method} ${req.path} chamada ${motivo} — seria BLOQUEADA no modo enforce`)
      return next()
    }
    log(`[SEGURANCA] ${req.method} ${req.path} bloqueada (${motivo})`)
    return res.status(recebido ? 403 : 401).json({ ok: false, error: 'Acesso restrito à administração do TMP10.' })
  }
}

module.exports = { criarExigirAdmin, tokensIguais }
