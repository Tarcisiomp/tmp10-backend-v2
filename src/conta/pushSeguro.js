// TMP10 — proteção das rotas de notificação push (/api/push/*).
//
// Problema (auditoria do pacote final): /api/push/subscribe, /notificar-venda e /notificar-mensagem aceitavam
// empresa_id e user_id enviados pelo navegador, sem login. Qualquer pessoa podia:
//   · inscrever o próprio navegador para receber os avisos de venda de OUTRA empresa;
//   · mandar notificação para os funcionários de qualquer empresa.
//
// Agora:
//   · COM sessão (Authorization: Bearer — o ERP envia sozinho para quem tem login novo):
//       a empresa e o usuário vêm da SESSÃO; empresa_id diferente no corpo → 403;
//       "notificar-mensagem" (Avisar Vendedores) só para admin da empresa.
//   · SEM sessão: aceito como antes só enquanto houver usuário no login antigo (sem sessão).
//     Com PUSH_EXIGIR_SESSAO=1 (ligar depois que todos migrarem), sem sessão → 401.
const { criarAutenticar, extrairToken } = require('../auth/sessao')

function criarProtecaoPush({ sb, exigirSessao = false, log = console.warn }) {
  const autenticar = criarAutenticar({ sb })
  return function protegerPush(req, res, next) {
    if (!extrairToken(req)) {
      if (exigirSessao) return res.status(401).json({ ok: false, error: 'Faça login para continuar.' })
      return next() // modo compatível com o login antigo (sem sessão)
    }
    autenticar(req, res, () => {
      const b = req.body && typeof req.body === 'object' ? req.body : (req.body = {})
      if (b.empresa_id && b.empresa_id !== req.empresaId) {
        log(`[PUSH][auditoria] empresa_id do navegador (${b.empresa_id}) diferente da sessão (${req.empresaId}) — recusado`)
        return res.status(403).json({ ok: false, error: 'Você não tem permissão para esta ação.' })
      }
      b.empresa_id = req.empresaId
      const rota = req.originalUrl.split('?')[0]
      if (rota === '/api/push/subscribe') b.user_id = req.usuario.id // nunca o user_id do navegador
      if (rota === '/api/push/notificar-mensagem' && (req.usuario.role !== 'admin' || req.usuario.is_vendedor_externo)) {
        return res.status(403).json({ ok: false, error: 'Você não tem permissão para esta ação.' })
      }
      next()
    })
  }
}

module.exports = { criarProtecaoPush }
