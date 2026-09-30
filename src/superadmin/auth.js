// TMP10 — Super Admin (painel da plataforma): quem pode entrar.
//
// Fluxo: Authorization: Bearer <access_token do Supabase Auth>
//        → o Supabase confere o token (sb.auth.getUser)
//        → o id do usuário precisa estar em SUPERADMIN_AUTH_IDS (variável do Railway)
//        → a conta NÃO pode ser usuário de empresa (public.users) — identidade da plataforma, separada dos clientes.
//
// Respostas: 401 = sem sessão / sessão inválida · 403 = logado, mas não é Super Admin

// Authorization: Bearer <token> → token (ou null). Cópia local da mesma função do passo 0.4,
// para o Super Admin não depender do módulo de sessão do ERP neste pacote isolado.
function extrairToken(req) {
  const h = req.get('authorization') || ''
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// "id1, id2" → Set de UUIDs válidos (entradas inválidas são ignoradas e registradas no log)
function lerIdsSuperAdmin(valor, log = console.warn) {
  const ids = new Set()
  for (const parte of String(valor || '').split(',')) {
    const id = parte.trim().toLowerCase()
    if (!id) continue
    if (UUID.test(id)) ids.add(id)
    else log('[SUPERADMIN] valor ignorado em SUPERADMIN_AUTH_IDS (não é um id de usuário válido)')
  }
  return ids
}

function criarExigirSuperAdmin({ sb, ids, log = console.warn }) {
  if (!sb) throw new Error('criarExigirSuperAdmin: cliente Supabase obrigatório')
  const autorizados = ids instanceof Set ? ids : lerIdsSuperAdmin(ids, log)
  if (autorizados.size === 0) log('[SUPERADMIN] SUPERADMIN_AUTH_IDS vazia — ninguém consegue usar o painel Super Admin')

  return async function exigirSuperAdmin(req, res, next) {
    const token = extrairToken(req)
    if (!token) return res.status(401).json({ ok: false, error: 'Faça login para continuar.' })
    try {
      const { data, error } = await sb.auth.getUser(token)
      const usuario = data && data.user
      if (error || !usuario || !usuario.id) return res.status(401).json({ ok: false, error: 'Sessão inválida ou expirada. Entre novamente.' })

      const id = String(usuario.id).toLowerCase()
      if (!autorizados.has(id)) {
        log(`[SUPERADMIN] acesso negado: usuário ${id} não está em SUPERADMIN_AUTH_IDS (${req.method} ${req.path})`)
        return res.status(403).json({ ok: false, error: 'Esta conta não tem acesso ao Super Admin.' })
      }
      // Separação: a conta do Super Admin não pode ser usuário de uma empresa cliente
      const { data: vinculo, error: errVinculo } = await sb.from('users').select('id').eq('auth_id', usuario.id).maybeSingle()
      if (errVinculo) return res.status(500).json({ ok: false, error: 'Não foi possível verificar seu acesso agora.' })
      if (vinculo) {
        log(`[SUPERADMIN] acesso negado: a conta ${id} está ligada a um usuário de empresa (public.users)`)
        return res.status(403).json({ ok: false, error: 'Esta conta está ligada a uma empresa cliente e não pode ser Super Admin.' })
      }
      req.superAdmin = { id, email: usuario.email || null }
      return next()
    } catch (e) {
      log(`[SUPERADMIN] falha ao validar sessão: ${e.message}`)
      return res.status(401).json({ ok: false, error: 'Sessão inválida ou expirada. Entre novamente.' })
    }
  }
}

module.exports = { criarExigirSuperAdmin, lerIdsSuperAdmin }
