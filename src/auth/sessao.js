// Sessão do usuário (Supabase Auth) — Etapa 0, passo 0.4.
//
// Regra: quem é o usuário e de qual empresa ele é vem SEMPRE da sessão validada no Supabase,
// nunca de um campo enviado pelo navegador (empresa_id, user_id, role...).
//
//   Authorization: Bearer <access_token da sessão do Supabase>
//     → sb.auth.getUser(token)       (o Supabase confere assinatura e validade)
//     → users.auth_id = id do Auth    (cadastro da pessoa no TMP10)
//     → req.usuario / req.empresaId

const CAMPOS_USUARIO = 'id, name, email, username, role, active, empresa_id, is_vendedor_externo, cargo, phone, auth_id'

function extrairToken(req) {
  const h = req.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function criarAutenticar({ sb, log = console.warn }) {
  if (!sb) throw new Error('criarAutenticar: cliente Supabase obrigatório')
  return async function autenticar(req, res, next) {
    const token = extrairToken(req)
    if (!token) return res.status(401).json({ ok: false, error: 'Faça login para continuar.' })
    try {
      const { data, error } = await sb.auth.getUser(token)
      const authUser = data && data.user
      if (error || !authUser || !authUser.id) {
        return res.status(401).json({ ok: false, error: 'Sessão inválida ou expirada. Entre novamente.' })
      }
      const { data: usuario, error: errUsuario } = await sb.from('users').select(CAMPOS_USUARIO).eq('auth_id', authUser.id).maybeSingle()
      if (errUsuario) {
        log(`[AUTH] erro ao buscar usuário: ${errUsuario.message}`)
        return res.status(500).json({ ok: false, error: 'Não foi possível verificar seu acesso agora.' })
      }
      if (!usuario || usuario.active !== true || !usuario.empresa_id) {
        return res.status(403).json({ ok: false, error: 'Seu acesso não está liberado. Fale com o administrador da sua empresa.' })
      }
      req.usuario = usuario
      req.empresaId = usuario.empresa_id
      return next()
    } catch (e) {
      log(`[AUTH] falha ao validar sessão: ${e.message}`)
      return res.status(401).json({ ok: false, error: 'Sessão inválida ou expirada. Entre novamente.' })
    }
  }
}

// Exige um dos papéis informados (ex.: exigirPapel('admin'))
function exigirPapel(...papeis) {
  return function (req, res, next) {
    if (req.usuario && papeis.includes(req.usuario.role) && !req.usuario.is_vendedor_externo) return next()
    return res.status(403).json({ ok: false, error: 'Você não tem permissão para esta ação.' })
  }
}

module.exports = { criarAutenticar, exigirPapel, extrairToken, CAMPOS_USUARIO }
