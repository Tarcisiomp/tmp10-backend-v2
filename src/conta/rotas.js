// Conta central do TMP10 — Etapa 0, passo 0.4.
//
//   GET   /api/conta/me               → quem está logado + empresa
//   POST  /api/conta/usuarios         → cria acesso (só admin da empresa)   [substitui o insert com senha feito pelo navegador]
//   PATCH /api/conta/usuarios/:id     → edita / ativa / desativa / troca senha (só admin da empresa)
//
// Funcionário SEM e-mail (opção A, ver src/conta/loginUsuario.js):
//   POST com { name, username, password } e sem e-mail → cria o cadastro + uma conta no Supabase Auth com o
//   identificador técnico interno <users.id>@<dominio> (nunca mostrado). Ele entra com usuário + senha.
// Troca de senha (PATCH { password }):
//   - quem tem conta no Supabase Auth (auth_id) → a senha muda no Auth;
//   - usuário ANTIGO, ainda não migrado (sem auth_id) → a senha muda em users.password, que é onde o login
//     antigo confere hoje (compatível com o fluxo atual até o 0.7). Depois o Super Admin migra normalmente.
//
// Regras:
//  - a empresa SEMPRE é a da sessão (req.empresaId). Qualquer empresa_id enviado pelo navegador é ignorado;
//  - um admin só enxerga e altera usuários da PRÓPRIA empresa (usuário de outra empresa = 404);
//  - nada é apagado: "excluir" no ERP vira "desativar" (bloqueia o login no Supabase Auth e marca active=false);
//  - quem tem conta no Supabase Auth NUNCA tem senha gravada na tabela users (a coluna password recebe um valor
//    inutilizável só porque é NOT NULL). A única exceção é a troca de senha de um usuário ANTIGO ainda não migrado
//    (o login antigo confere users.password); ela some no 0.7.

const crypto = require('crypto')
const express = require('express')
const { criarAutenticar, exigirPapel } = require('../auth/sessao')

const PAPEIS = ['admin', 'employee', 'vendedor']
const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
// Usuário de login (sem e-mail): minúsculas, números, ponto, hífen e sublinhado; 3 a 40; começa com letra/número
const USUARIO_OK = /^[a-z0-9][a-z0-9._-]{2,39}$/
const BLOQUEIO_LONGO = '876000h' // ~100 anos: usado para desativar o login sem apagar a conta
// Empresa sem acesso ao TMP10 (mesma regra do Super Admin, src/superadmin/assinatura.js):
// o admin da empresa NÃO consegue criar nem reativar funcionário enquanto a empresa estiver bloqueada, inativa ou cancelada.
const EMPRESA_SEM_ACESSO = ['bloqueado', 'inativo', 'cancelado']
const MSG_EMPRESA_SEM_ACESSO = 'O acesso da sua empresa ao TMP10 está suspenso. Não é possível criar ou reativar usuários agora.'

function limparTexto(v, max = 120) {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s ? s.slice(0, max) : null
}

function senhaInutilizavel() {
  // users.password é NOT NULL na estrutura atual. Este valor nunca é uma senha válida.
  return '!supabase-auth:' + crypto.randomBytes(24).toString('hex')
}

// 8 caracteres no mínimo; até 72 BYTES (limite do bcrypt do Supabase Auth); sem espaço no início/fim
// (o login por usuário sempre confere a senha com trim(), então essa senha nunca funcionaria)
function validarSenha(s) {
  return typeof s === 'string' && s.length >= 8 && Buffer.byteLength(s, 'utf8') <= 72 && s === s.trim()
}
const MSG_SENHA = 'A senha precisa ter pelo menos 8 caracteres, sem espaço no início ou no fim.'

function publico(u) {
  if (!u) return null
  return {
    id: u.id, name: u.name, email: u.email || null, username: u.username || null, role: u.role, active: u.active,
    empresa_id: u.empresa_id, is_vendedor_externo: !!u.is_vendedor_externo, cargo: u.cargo || null, phone: u.phone || null
  }
}

function criarRotasConta({ sb, appUrl, dominioTecnico = 'login.tmp10.com.br', log = console.log }) {
  const router = express.Router()
  const autenticar = criarAutenticar({ sb })
  const soAdmin = exigirPapel('admin')

  // ── quem sou ──────────────────────────────────────────────────────
  router.get('/api/conta/me', autenticar, async (req, res) => {
    const { data: empresa } = await sb.from('empresas').select('id, nome_empresa, modulos, status').eq('id', req.empresaId).maybeSingle()
    res.json({ ok: true, usuario: publico(req.usuario), empresa: empresa || { id: req.empresaId } })
  })

  // ── criar acesso ──────────────────────────────────────────────────
  // Status da empresa da sessão: { semAcesso, status } ou { erro }
  async function acessoDaEmpresa(empresaId) {
    const { data: emp, error } = await sb.from('empresas').select('status').eq('id', empresaId).maybeSingle()
    if (error || !emp) return { erro: true }
    return { semAcesso: EMPRESA_SEM_ACESSO.includes(emp.status), status: emp.status }
  }

  router.post('/api/conta/usuarios', autenticar, soAdmin, async (req, res) => {
    // Empresa sem acesso (bloqueada, inativa ou cancelada) não cria funcionário — nada é gravado
    const acesso = await acessoDaEmpresa(req.empresaId)
    if (acesso.erro) return res.status(500).json({ ok: false, error: 'Não foi possível criar o acesso. Tente de novo.' })
    if (acesso.semAcesso) {
      log(`[CONTA][auditoria] criação de usuário RECUSADA: empresa ${req.empresaId} está ${acesso.status}`)
      return res.status(403).json({ ok: false, error: MSG_EMPRESA_SEM_ACESSO })
    }
    const b = req.body || {}
    const nome = limparTexto(b.name)
    const email = limparTexto(b.email, 254)?.toLowerCase() || null
    const role = PAPEIS.includes(b.role) ? b.role : 'employee'
    const vendedorExterno = b.is_vendedor_externo === true
    const senha = b.password ? String(b.password) : null

    if (!nome) return res.status(400).json({ ok: false, error: 'Informe o nome.' })
    // Sem e-mail + usuário informado = funcionário que entra com usuário + senha (conta técnica)
    if (!email && b.username !== undefined && b.username !== null && String(b.username).trim()) {
      return criarSemEmail(req, res, { nome, role, vendedorExterno, senha, b })
    }
    if (!email || !EMAIL_OK.test(email)) return res.status(400).json({ ok: false, error: 'Informe um e-mail válido (ou um usuário, para quem não usa e-mail).' })
    if (senha && !validarSenha(senha)) return res.status(400).json({ ok: false, error: MSG_SENHA })

    const { data: jaExiste } = await sb.from('users').select('id').eq('email', email).maybeSingle()
    if (jaExiste) return res.status(409).json({ ok: false, error: 'Este e-mail já tem acesso ao TMP10.' })

    // 1) cria a conta no Supabase Auth
    let authId
    let convite = false
    if (senha) {
      const { data, error } = await sb.auth.admin.createUser({ email, password: senha, email_confirm: true })
      if (error) return res.status(400).json({ ok: false, error: traduzirErroAuth(error) })
      authId = data.user.id
    } else {
      const { data, error } = await sb.auth.admin.inviteUserByEmail(email, { redirectTo: appUrl })
      if (error) return res.status(400).json({ ok: false, error: traduzirErroAuth(error) })
      authId = data.user.id
      convite = true
    }

    // 2) cria o cadastro no TMP10, SEMPRE na empresa de quem está logado
    const linha = {
      empresa_id: req.empresaId,
      auth_id: authId,
      email,
      username: email,
      password: senhaInutilizavel(),
      name: nome,
      role: vendedorExterno ? 'vendedor' : role,
      is_vendedor_externo: vendedorExterno,
      active: true,
      phone: limparTexto(b.phone, 40),
      cargo: limparTexto(b.cargo, 80)
    }
    const { data: criado, error: errInsert } = await sb.from('users').insert(linha).select('id, name, email, role, active, empresa_id, is_vendedor_externo, cargo, phone').single()
    if (errInsert || !criado) {
      // desfaz a conta do Auth para não deixar login "órfão"
      await sb.auth.admin.deleteUser(authId).catch(() => {})
      if (errInsert && errInsert.code === '23505') return res.status(409).json({ ok: false, error: 'Este e-mail já tem acesso ao TMP10.' })
      log(`[CONTA] falha ao criar usuário na empresa ${req.empresaId}: ${errInsert ? errInsert.message : 'sem retorno'}`)
      return res.status(500).json({ ok: false, error: 'Não foi possível criar o acesso. Tente de novo.' })
    }
    log(`[CONTA][auditoria] usuário ${criado.id} criado por ${req.usuario.id} na empresa ${req.empresaId} (papel ${criado.role}${convite ? ', convite por e-mail' : ''})`)
    res.status(201).json({ ok: true, usuario: publico(criado), convite })
  })

  // Funcionário sem e-mail: cadastro → conta no Auth com o identificador técnico → liga o auth_id.
  // Se algo falhar no meio, desfaz só o que acabou de criar (nada que já existia é tocado).
  async function criarSemEmail(req, res, { nome, role, vendedorExterno, senha, b }) {
    const usuario = String(b.username).trim().toLowerCase()
    if (!USUARIO_OK.test(usuario)) return res.status(400).json({ ok: false, error: 'Usuário inválido: use de 3 a 40 letras minúsculas, números, ponto, hífen ou sublinhado (sem espaço e sem @).' })
    if (!senha) return res.status(400).json({ ok: false, error: 'Defina uma senha para quem entra com usuário (não há e-mail para enviar convite).' })
    if (!validarSenha(senha)) return res.status(400).json({ ok: false, error: MSG_SENHA })
    // O login por usuário procura o usuário em TODAS as empresas: ele precisa ser único no TMP10 inteiro
    const { data: repetidos, error: errBusca } = await sb.from('users').select('id').eq('username', usuario).limit(1)
    if (errBusca) return res.status(500).json({ ok: false, error: 'Não foi possível criar o acesso. Tente de novo.' })
    if (repetidos && repetidos.length) return res.status(409).json({ ok: false, error: 'Este usuário já existe no TMP10. Escolha outro.' })

    const linha = {
      empresa_id: req.empresaId, auth_id: null, email: null, username: usuario, password: senhaInutilizavel(),
      name: nome, role: vendedorExterno ? 'vendedor' : role, is_vendedor_externo: vendedorExterno, active: true,
      phone: limparTexto(b.phone, 40), cargo: limparTexto(b.cargo, 80)
    }
    const { data: criado, error: errInsert } = await sb.from('users').insert(linha).select('id, name, email, username, role, active, empresa_id, is_vendedor_externo, cargo, phone').single()
    if (errInsert || !criado) {
      log(`[CONTA] falha ao criar usuário (sem e-mail) na empresa ${req.empresaId}: ${errInsert ? errInsert.message : 'sem retorno'}`)
      return res.status(500).json({ ok: false, error: 'Não foi possível criar o acesso. Tente de novo.' })
    }
    const desfazerCadastro = () => sb.from('users').delete().eq('id', criado.id).eq('empresa_id', req.empresaId).is('auth_id', null)
    const { data: conta, error: errAuth } = await sb.auth.admin.createUser({
      email: `${String(criado.id).toLowerCase()}@${dominioTecnico}`, password: senha, email_confirm: true, app_metadata: { tmp10_login_tecnico: true }
    })
    if (errAuth || !conta || !conta.user) {
      await desfazerCadastro()
      return res.status(400).json({ ok: false, error: traduzirErroAuth(errAuth) })
    }
    const { data: ligados, error: errLiga } = await sb.from('users').update({ auth_id: conta.user.id }).eq('id', criado.id).is('auth_id', null).select('id')
    if (errLiga || !ligados || !ligados.length) {
      await sb.auth.admin.deleteUser(conta.user.id).catch(() => {})
      await desfazerCadastro()
      return res.status(500).json({ ok: false, error: 'Não foi possível criar o acesso. Tente de novo.' })
    }
    log(`[CONTA][auditoria] usuário ${criado.id} (login por usuário) criado por ${req.usuario.id} na empresa ${req.empresaId} (papel ${criado.role})`)
    return res.status(201).json({ ok: true, usuario: publico(criado), convite: false })
  }

  // ── editar / ativar / desativar / trocar senha ───────────────────
  router.patch('/api/conta/usuarios/:id', autenticar, soAdmin, async (req, res) => {
    const { data: alvo } = await sb.from('users').select('id, auth_id, empresa_id, active, role, email, username').eq('id', req.params.id).eq('empresa_id', req.empresaId).maybeSingle()
    // usuário de outra empresa é tratado como inexistente
    if (!alvo || alvo.empresa_id !== req.empresaId) return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })

    const b = req.body || {}
    const proprio = alvo.id === req.usuario.id
    const upd = {}
    if (b.name !== undefined) { const n = limparTexto(b.name); if (!n) return res.status(400).json({ ok: false, error: 'Informe o nome.' }); upd.name = n }
    if (b.phone !== undefined) upd.phone = limparTexto(b.phone, 40)
    if (b.cargo !== undefined) upd.cargo = limparTexto(b.cargo, 80)
    if (b.role !== undefined) {
      if (!PAPEIS.includes(b.role)) return res.status(400).json({ ok: false, error: 'Papel inválido.' })
      if (proprio && b.role !== alvo.role) return res.status(400).json({ ok: false, error: 'Você não pode mudar o seu próprio papel.' })
      upd.role = b.role
    }
    if (b.active !== undefined) {
      if (proprio && b.active === false) return res.status(400).json({ ok: false, error: 'Você não pode desativar sua própria conta.' })
      upd.active = b.active === true
    }
    let novoEmail = null
    if (b.email !== undefined) {
      novoEmail = limparTexto(b.email, 254)?.toLowerCase() || null
      if (!novoEmail || !EMAIL_OK.test(novoEmail)) return res.status(400).json({ ok: false, error: 'Informe um e-mail válido.' })
      if (novoEmail !== (alvo.email || '').toLowerCase()) {
        const { data: outro } = await sb.from('users').select('id').eq('email', novoEmail).maybeSingle()
        if (outro && outro.id !== alvo.id) return res.status(409).json({ ok: false, error: 'Este e-mail já tem acesso ao TMP10.' })
        upd.email = novoEmail
        upd.username = novoEmail
      } else novoEmail = null
    }
    const senha = b.password ? String(b.password) : null
    if (senha && !validarSenha(senha)) return res.status(400).json({ ok: false, error: MSG_SENHA })

    // Reativar funcionário só se a empresa tiver acesso ao TMP10 (antes de mexer no Auth ou no banco)
    if (upd.active === true && alvo.active === false) {
      const acesso = await acessoDaEmpresa(req.empresaId)
      if (acesso.erro) return res.status(500).json({ ok: false, error: 'Não foi possível salvar. Tente de novo.' })
      if (acesso.semAcesso) {
        log(`[CONTA][auditoria] reativação do usuário ${alvo.id} RECUSADA: empresa ${req.empresaId} está ${acesso.status}`)
        return res.status(403).json({ ok: false, error: MSG_EMPRESA_SEM_ACESSO })
      }
    }

    // alterações no Supabase Auth (login)
    if (alvo.auth_id) {
      const mudancaAuth = {}
      if (novoEmail) { mudancaAuth.email = novoEmail; mudancaAuth.email_confirm = true }
      if (senha) mudancaAuth.password = senha
      if (upd.active === false) mudancaAuth.ban_duration = BLOQUEIO_LONGO
      if (upd.active === true && alvo.active === false) mudancaAuth.ban_duration = 'none'
      if (Object.keys(mudancaAuth).length) {
        const { error } = await sb.auth.admin.updateUserById(alvo.auth_id, mudancaAuth)
        if (error) return res.status(400).json({ ok: false, error: traduzirErroAuth(error) })
      }
    } else if (novoEmail) {
      return res.status(409).json({ ok: false, error: 'Este usuário ainda não tem conta de login nova. Troque só a senha; a migração do login é feita pelo suporte TMP10.' })
    } else if (senha) {
      // Usuário ANTIGO (ainda não migrado): o login antigo confere users.password — a nova senha vale a partir de agora
      // e a antiga deixa de funcionar. Depois disso a migração (Super Admin) copia esta senha para o Supabase Auth.
      upd.password = senha
    }

    if (Object.keys(upd).length) {
      const { error } = await sb.from('users').update(upd).eq('id', alvo.id).eq('empresa_id', req.empresaId)
      if (error && error.code === '23505') return res.status(409).json({ ok: false, error: 'Este e-mail já tem acesso ao TMP10.' })
      if (error) return res.status(500).json({ ok: false, error: 'Não foi possível salvar. Tente de novo.' })
    }
    log(`[CONTA][auditoria] usuário ${alvo.id} alterado por ${req.usuario.id} na empresa ${req.empresaId}: ${[...Object.keys(upd).filter((k) => k !== 'password'), senha ? 'senha' : null].filter(Boolean).join(', ') || 'nada'}`)
    res.json({ ok: true })
  })

  return router
}

function traduzirErroAuth(error) {
  const msg = String((error && error.message) || '')
  if (/already|registered|exists/i.test(msg)) return 'Este e-mail já tem acesso ao TMP10.'
  if (/password/i.test(msg)) return 'Senha fraca ou inválida. Use pelo menos 8 caracteres.'
  if (/rate|limit/i.test(msg)) return 'Muitos e-mails enviados em pouco tempo. Aguarde alguns minutos e tente de novo.'
  if (/email/i.test(msg)) return 'E-mail inválido.'
  return 'Não foi possível concluir. Tente de novo.'
}

module.exports = { criarRotasConta, PAPEIS, EMPRESA_SEM_ACESSO, validarSenha, USUARIO_OK }
