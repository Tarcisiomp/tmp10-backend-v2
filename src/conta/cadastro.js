// Cadastro público de cliente novo (TMP10 E-commerce) — Etapa 0, passo 0.4.
//
//   POST /api/conta/cadastro   { empresa, nome, email, whatsapp, senha }
//
// Substitui o cadastro que o site tmp10.com.br fazia DIRETO no banco pelo navegador
// (empresa + usuário com senha em texto puro + entrada no ERP por ?auto=<id>).
// Agora, tudo no servidor:
//   1) confere se o e-mail já tem conta;
//   2) cria a conta de login no Supabase Auth (a senha fica só lá, criptografada);
//   3) cria a empresa com OS MESMOS campos que o site gravava (status/plano "trial", trial_fim = hoje + 7 dias);
//   4) cria o primeiro usuário (admin) ligado à conta de login;
//   5) (opcional) abre a sessão para o cliente entrar no ERP sem digitar a senha de novo.
// Se algum passo falhar, desfaz SÓ o que este mesmo cadastro acabou de criar (nada que já existia é tocado).

const crypto = require('crypto')
const express = require('express')

const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

function texto(v, max) {
  const s = String(v === undefined || v === null ? '' : v).trim()
  return s.slice(0, max)
}

// Limite simples de tentativas por IP (em memória) para evitar cadastro em massa
function criarLimitador({ maxPorJanela = 5, janelaMs = 60 * 60 * 1000, agora = () => Date.now() } = {}) {
  const hits = new Map()
  return function limitar(req, res, next) {
    const ip = String(req.headers['x-forwarded-for'] || req.ip || req.socket?.remoteAddress || '').split(',')[0].trim() || 'desconhecido'
    const t = agora()
    const lista = (hits.get(ip) || []).filter((x) => t - x < janelaMs)
    if (lista.length >= maxPorJanela) {
      hits.set(ip, lista)
      return res.status(429).json({ ok: false, error: 'Muitas tentativas de cadastro. Aguarde um pouco e tente de novo.' })
    }
    lista.push(t)
    hits.set(ip, lista)
    next()
  }
}

function criarRotaCadastro({ sb, criarClientePublico, limitador = criarLimitador(), log = console.log }) {
  const router = express.Router()

  router.post('/api/conta/cadastro', limitador, async (req, res) => {
    const b = req.body || {}
    const empresa = texto(b.empresa, 120)
    const nome = texto(b.nome, 120)
    const email = texto(b.email, 254).toLowerCase()
    const whatsapp = texto(b.whatsapp, 40)
    const senha = typeof b.senha === 'string' ? b.senha : ''

    if (!empresa || !nome || !email || !whatsapp || !senha) return res.status(400).json({ ok: false, error: 'Preencha todos os campos obrigatórios.' })
    if (!EMAIL_OK.test(email)) return res.status(400).json({ ok: false, error: 'Informe um e-mail válido.' })
    if (whatsapp.replace(/\D/g, '').length < 10) return res.status(400).json({ ok: false, error: 'Informe um WhatsApp válido, com DDD.' })
    if (senha.length < 8 || senha.length > 72) return res.status(400).json({ ok: false, error: 'A senha precisa ter pelo menos 8 caracteres.' })

    // 1) e-mail já usado? (contas novas guardam em "email"; as antigas do site guardavam o e-mail em "username")
    const [{ data: porEmail }, { data: porUsuario }] = await Promise.all([
      sb.from('users').select('id').eq('email', email).maybeSingle(),
      sb.from('users').select('id').eq('username', email).maybeSingle()
    ])
    if (porEmail || porUsuario) return res.status(409).json({ ok: false, error: 'Já existe uma conta com esse e-mail. Tente entrar em vez de cadastrar.' })

    // 2) conta de login
    const { data: criado, error: errAuth } = await sb.auth.admin.createUser({ email, password: senha, email_confirm: true })
    if (errAuth || !criado || !criado.user) {
      const m = String((errAuth && errAuth.message) || '')
      if (/already|registered|exists/i.test(m)) return res.status(409).json({ ok: false, error: 'Já existe uma conta com esse e-mail. Tente entrar em vez de cadastrar.' })
      log(`[CADASTRO] falha ao criar login: ${m}`)
      return res.status(500).json({ ok: false, error: 'Não foi possível criar sua conta. Tente de novo.' })
    }
    const authId = criado.user.id

    // 3) empresa — mesmos campos que o site gravava antes
    const trialFim = new Date()
    trialFim.setDate(trialFim.getDate() + 7)
    const { data: emp, error: errEmp } = await sb.from('empresas').insert({
      nome_empresa: empresa,
      nome_responsavel: nome,
      email,
      whatsapp,
      status: 'trial',
      plano: 'trial',
      trial_fim: trialFim.toISOString().slice(0, 10)
    }).select('id').single()
    if (errEmp || !emp) {
      await sb.auth.admin.deleteUser(authId).catch(() => {})
      log(`[CADASTRO] falha ao criar empresa: ${errEmp ? errEmp.message : 'sem retorno'}`)
      return res.status(500).json({ ok: false, error: 'Não foi possível criar sua conta. Tente de novo.' })
    }

    // 4) primeiro usuário (admin) da empresa
    const { data: usuario, error: errUser } = await sb.from('users').insert({
      empresa_id: emp.id,
      auth_id: authId,
      email,
      username: email,
      password: '!supabase-auth:' + crypto.randomBytes(24).toString('hex'), // coluna obrigatória; nunca é uma senha válida
      name: nome,
      role: 'admin',
      phone: whatsapp,
      active: true
    }).select('id').single()
    if (errUser || !usuario) {
      // desfaz só o que ESTE cadastro criou
      await sb.from('empresas').delete().eq('id', emp.id)
      await sb.auth.admin.deleteUser(authId).catch(() => {})
      log(`[CADASTRO] falha ao criar usuário: ${errUser ? errUser.message : 'sem retorno'}`)
      if (errUser && errUser.code === '23505') return res.status(409).json({ ok: false, error: 'Já existe uma conta com esse e-mail. Tente entrar em vez de cadastrar.' })
      return res.status(500).json({ ok: false, error: 'Não foi possível criar sua conta. Tente de novo.' })
    }
    log(`[CADASTRO][auditoria] empresa ${emp.id} e usuário ${usuario.id} criados (trial até ${trialFim.toISOString().slice(0, 10)})`)

    // 5) sessão para entrar direto no ERP (se a chave pública estiver configurada)
    let sessao = null
    if (criarClientePublico) {
      try {
        const publico = criarClientePublico()
        const { data: s, error } = await publico.auth.signInWithPassword({ email, password: senha })
        if (!error && s && s.session) {
          sessao = { access_token: s.session.access_token, refresh_token: s.session.refresh_token, expires_in: s.session.expires_in, expires_at: s.session.expires_at, token_type: 'bearer' }
        }
      } catch (e) {
        log(`[CADASTRO] conta criada, mas não abri a sessão: ${e.message}`)
      }
    }
    res.status(201).json({ ok: true, sessao })
  })

  return router
}

module.exports = { criarRotaCadastro, criarLimitador }
