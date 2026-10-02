// TMP10 — Login por USUÁRIO + SENHA para funcionários sem e-mail (preparação para o RLS 0.5).
//
// Por quê: depois do RLS 0.5 o banco só entrega dados a quem tem SESSÃO do Supabase Auth ligada ao usuário
// (users.auth_id). O Supabase Auth só aceita e-mail ou telefone como identificador. Para funcionários que não
// usam e-mail, cada um ganha uma conta no Auth com um IDENTIFICADOR TÉCNICO INTERNO:
//     <users.id>@login.tmp10.com.br
//   - não é e-mail de ninguém, nunca recebe mensagem e não aparece em lugar nenhum;
//   - o funcionário continua digitando o MESMO usuário e a MESMA senha de hoje;
//   - a conta é ligada ao MESMO registro (users.id) → empresa, papel, vendedor, histórico continuam iguais.
//
// Rotas:
//   POST /api/conta/entrar-usuario                     { usuario, senha }  → sessão do Supabase (público, com limite)
//   GET  /api/superadmin/migracao-login                                    → situação de cada usuário (só Super Admin)
//   POST /api/superadmin/migracao-login/:id            { simular }         → migra UM usuário (só Super Admin)
//   POST /api/superadmin/migracao-login/:id/desfazer                       → desfaz a migração de UM usuário (só Super Admin)
// Nenhuma rota devolve senha. A senha atual é lida SÓ no servidor, uma vez, para criar a conta no Auth com ela.
const express = require('express')

const DOMINIO_PADRAO = 'login.tmp10.com.br'
const EMPRESA_SEM_ACESSO = ['bloqueado', 'inativo', 'cancelado'] // mesma regra do Super Admin V4
const BLOQUEIO_LONGO = '876000h'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MSG_INCORRETO = 'Usuário ou senha incorretos.'
const MSG_SUSPENSO = 'O acesso da sua empresa ao TMP10 está suspenso. Fale com o suporte TMP10.'

function senhaUtilizavel(senha, minimo) {
  // 72 = limite em BYTES do bcrypt usado pelo Supabase Auth; espaço no início/fim nunca funcionou no login
  // antigo (o ERP sempre comparou a senha com trim()), então essa senha precisa ser trocada antes
  return typeof senha === 'string' && senha.length >= minimo && Buffer.byteLength(senha, 'utf8') <= 72 &&
    senha === senha.trim() && !senha.startsWith('!supabase-auth:')
}

// Limite de tentativas: por IP + usuário (erro de digitação de um não trava o escritório inteiro), por IP no total
// e por USUÁRIO de qualquer IP (o IP vem do X-Forwarded-For, que quem ataca pode trocar a cada tentativa).
function criarLimitadorLogin({ porUsuario = 10, porIp = 60, porUsuarioTotal = 30, janelaMs = 15 * 60 * 1000, agora = () => Date.now() } = {}) {
  const hits = new Map()
  const contar = (chave, max, t) => {
    const lista = (hits.get(chave) || []).filter((x) => t - x < janelaMs)
    if (lista.length >= max) { hits.set(chave, lista); return false }
    lista.push(t); hits.set(chave, lista); return true
  }
  const limparVelhos = (t) => { for (const [k, l] of hits) if (!l.length || t - l[l.length - 1] >= janelaMs) hits.delete(k) }
  return function limitar(req, res, next) {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim() || 'desconhecido'
    const usuario = String((req.body && req.body.usuario) || '').trim().toLowerCase()
    const t = agora()
    if (hits.size > 10000) limparVelhos(t) // memória não cresce sem limite
    if (!contar('ip:' + ip, porIp, t) || !contar('u:' + ip + ':' + usuario, porUsuario, t) || !contar('total:' + usuario, porUsuarioTotal, t)) {
      return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' })
    }
    next()
  }
}

function criarRotasLoginUsuario({ sb, criarClienteLogin, exigirSuperAdmin, dominio = DOMINIO_PADRAO, senhaMinima = 6, limitador = criarLimitadorLogin(), log = console.log }) {
  if (!sb || !criarClienteLogin || !exigirSuperAdmin) throw new Error('criarRotasLoginUsuario: sb, criarClienteLogin e exigirSuperAdmin são obrigatórios')
  const router = express.Router()
  const emailTecnico = (id) => `${String(id).toLowerCase()}@${dominio}`
  const ehTecnico = (email) => String(email || '').toLowerCase().endsWith('@' + dominio)

  async function empresaSemAcesso(empresaId) {
    const { data } = await sb.from('empresas').select('status').eq('id', empresaId).maybeSingle()
    return !!(data && EMPRESA_SEM_ACESSO.includes(data.status))
  }
  async function emailDaConta(authId) {
    const { data, error } = await sb.auth.admin.getUserById(authId)
    if (error || !data || !data.user) return null
    return data.user.email || null
  }

  // ── Login por usuário + senha ───────────────────────────────────
  router.post('/api/conta/entrar-usuario', limitador, async (req, res) => {
    const b = req.body || {}
    const usuario = String(b.usuario || '').trim().toLowerCase()
    const senha = typeof b.senha === 'string' ? b.senha.trim() : '' // o login antigo sempre usou a senha com trim()
    if (!usuario || !senha) return res.status(400).json({ ok: false, error: 'Preencha usuário e senha.' })
    if (usuario.includes('@')) return res.status(400).json({ ok: false, error: 'Para entrar com e-mail, digite o e-mail no campo de login.' })
    try {
      const { data: u, error } = await sb.from('users').select('id, auth_id, empresa_id, password, active').eq('username', usuario).eq('active', true).maybeSingle()
      if (error || !u) return res.status(401).json({ ok: false, error: MSG_INCORRETO })

      // Ainda não migrado: a senha é conferida aqui, no servidor; o ERP usa o login antigo (válido até o RLS 0.5)
      if (!u.auth_id) {
        if (u.password !== senha) return res.status(401).json({ ok: false, error: MSG_INCORRETO })
        return res.status(409).json({ ok: false, naoMigrado: true })
      }

      const email = await emailDaConta(u.auth_id)
      if (!email) return res.status(500).json({ ok: false, error: 'Não foi possível entrar agora. Tente de novo.' })
      const cliente = criarClienteLogin()
      const { data: s, error: errLogin } = await cliente.auth.signInWithPassword({ email, password: senha })
      if (errLogin || !s || !s.session) {
        if (/banned/i.test(String(errLogin && errLogin.message))) return res.status(403).json({ ok: false, error: MSG_SUSPENSO })
        return res.status(401).json({ ok: false, error: MSG_INCORRETO })
      }
      // Senha certa — agora sim pode dizer o resto
      if (!ehTecnico(email)) return res.status(403).json({ ok: false, error: 'Este usuário já usa o login por e-mail. Entre com o seu e-mail.' })
      if (await empresaSemAcesso(u.empresa_id)) return res.status(403).json({ ok: false, error: MSG_SUSPENSO })
      log(`[CONTA][auditoria] login por usuário: ${u.id}`)
      const ss = s.session
      return res.json({ ok: true, sessao: { access_token: ss.access_token, refresh_token: ss.refresh_token, expires_in: ss.expires_in, expires_at: ss.expires_at, token_type: 'bearer' } })
    } catch (e) {
      log(`[CONTA] erro no login por usuário: ${e.message}`)
      return res.status(500).json({ ok: false, error: 'Não foi possível entrar agora. Tente de novo.' })
    }
  })

  // ── Migração (só Super Admin) ───────────────────────────────────
  router.use('/api/superadmin/migracao-login', exigirSuperAdmin)
  const auditoria = (req, msg) => log(`[SUPERADMIN][auditoria] ${req.superAdmin ? req.superAdmin.id : '?'}: ${msg}`)

  function motivoNaoPronto(u) {
    if (!u.active) return 'usuário inativo'
    if (u.auth_id) return 'já migrado'
    if (!u.username || !String(u.username).trim()) return 'sem usuário (username)'
    if (String(u.username).includes('@')) return 'username com @ (deve entrar pelo e-mail)'
    if (!senhaUtilizavel(u.password, senhaMinima)) return `senha atual não pode ser copiada (vazia, menos de ${senhaMinima} caracteres, mais de 72 bytes ou com espaço no início/fim) — troque a senha antes`
    return null
  }

  router.get('/api/superadmin/migracao-login', async (req, res) => {
    try {
      const [{ data: users, error }, { data: empresas }] = await Promise.all([
        sb.from('users').select('id, name, username, password, auth_id, active, empresa_id, role, is_vendedor_externo').order('name'),
        sb.from('empresas').select('id, nome_empresa, status')
      ])
      if (error) throw error
      const nomeEmp = Object.fromEntries((empresas || []).map((e) => [e.id, e]))
      const lista = []
      for (const u of users || []) {
        if (!u.active) continue
        let situacao = 'antigo'
        if (u.auth_id) situacao = ehTecnico(await emailDaConta(u.auth_id)) ? 'usuario_e_senha (migrado)' : 'email (migrado)'
        const motivo = u.auth_id ? null : motivoNaoPronto(u)
        lista.push({
          id: u.id, nome: u.name, usuario: u.username, empresa: (nomeEmp[u.empresa_id] || {}).nome_empresa || null,
          role: u.role, vendedor_externo: !!u.is_vendedor_externo, situacao,
          pode_migrar: !u.auth_id && !motivo, motivo: u.auth_id ? null : motivo
        })
      }
      res.json({ ok: true, usuarios: lista, faltam: lista.filter((x) => x.situacao === 'antigo').length })
    } catch (e) {
      log(`[SUPERADMIN] migracao-login: ${e.message}`)
      res.status(500).json({ ok: false, error: 'Não foi possível listar agora.' })
    }
  })

  router.post('/api/superadmin/migracao-login/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
    const simular = !(req.body && req.body.simular === false)
    try {
      const { data: u } = await sb.from('users').select('id, name, username, password, auth_id, active, empresa_id, role, is_vendedor_externo').eq('id', req.params.id).maybeSingle()
      if (!u) return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      const motivo = motivoNaoPronto(u)
      if (motivo) return res.status(409).json({ ok: false, error: `Não dá para migrar ${u.name}: ${motivo}. Nada foi alterado.` })
      const email = emailTecnico(u.id)
      const plano = { usuario: u.username, nome: u.name, identificador_tecnico: email, role: u.role, vendedor_externo: !!u.is_vendedor_externo, empresa_id: u.empresa_id, senha: 'a mesma de hoje (não é exibida)' }
      if (simular) return res.json({ ok: true, simulacao: true, plano, aviso: 'Simulação: nada foi alterado. Para migrar de verdade, envie { "simular": false }.' })

      const { data: criado, error: errAuth } = await sb.auth.admin.createUser({ email, password: u.password, email_confirm: true, app_metadata: { tmp10_login_tecnico: true } })
      if (errAuth || !criado || !criado.user) {
        const m = String((errAuth && errAuth.message) || '')
        log(`[SUPERADMIN] migração de ${u.id} recusada pelo Auth: ${m}`)
        if (/password/i.test(m)) return res.status(409).json({ ok: false, error: `O Supabase não aceitou a senha atual de ${u.name} (${m}). Troque a senha dele antes. Nada foi alterado.` })
        if (/already|registered|exists/i.test(m)) return res.status(409).json({ ok: false, error: 'Já existe uma conta com esse identificador técnico. Nada foi alterado.' })
        return res.status(500).json({ ok: false, error: 'Não foi possível criar a conta. Nada foi alterado.' })
      }
      const authId = criado.user.id
      const { data: ligados, error: errLiga } = await sb.from('users').update({ auth_id: authId }).eq('id', u.id).is('auth_id', null).select('id')
      if (errLiga || !ligados || !ligados.length) {
        await sb.auth.admin.deleteUser(authId).catch(() => {})
        return res.status(409).json({ ok: false, error: 'O usuário mudou durante a migração (já ligado?). A conta criada foi desfeita. Nada foi alterado.' })
      }
      // Empresa já sem acesso (bloqueada/inativa/cancelada) → a conta nova nasce suspensa, como as demais da empresa
      let suspenso = false
      if (await empresaSemAcesso(u.empresa_id)) {
        const { error: errBan } = await sb.auth.admin.updateUserById(authId, { ban_duration: BLOQUEIO_LONGO })
        suspenso = !errBan
      }
      auditoria(req, `migrou o login de ${u.id} (${u.username}) para usuário+senha (Auth ${authId})${suspenso ? ' — empresa sem acesso, login suspenso' : ''}`)
      return res.json({ ok: true, migrado: true, plano, loginSuspenso: suspenso })
    } catch (e) {
      log(`[SUPERADMIN] migração ${req.params.id}: ${e.message}`)
      return res.status(500).json({ ok: false, error: 'Não foi possível migrar agora.' })
    }
  })

  // Desfaz UMA migração por usuário+senha (volta ao login antigo). Só para contas com identificador técnico.
  router.post('/api/superadmin/migracao-login/:id/desfazer', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
    try {
      const { data: u } = await sb.from('users').select('id, name, auth_id').eq('id', req.params.id).maybeSingle()
      if (!u || !u.auth_id) return res.status(409).json({ ok: false, error: 'Esse usuário não está migrado. Nada foi alterado.' })
      const email = await emailDaConta(u.auth_id)
      if (!ehTecnico(email)) return res.status(409).json({ ok: false, error: 'Esse usuário entra por e-mail real — não é desfeito por aqui. Nada foi alterado.' })
      const { error } = await sb.from('users').update({ auth_id: null }).eq('id', u.id).eq('auth_id', u.auth_id)
      if (error) throw error
      await sb.auth.admin.deleteUser(u.auth_id).catch(() => {})
      auditoria(req, `desfez a migração de ${u.id}`)
      return res.json({ ok: true, desfeito: true })
    } catch (e) {
      log(`[SUPERADMIN] desfazer migração ${req.params.id}: ${e.message}`)
      return res.status(500).json({ ok: false, error: 'Não foi possível desfazer agora.' })
    }
  })

  return router
}

module.exports = { criarRotasLoginUsuario, criarLimitadorLogin, senhaUtilizavel, DOMINIO_PADRAO, EMPRESA_SEM_ACESSO }
