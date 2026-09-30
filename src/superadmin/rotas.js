// TMP10 — rotas do painel Super Admin (/api/superadmin/*).
// Tudo passa por exigirSuperAdmin (auth.js). O banco é acessado SÓ aqui no servidor, com a chave de
// serviço (cliente `sb`), que nunca vai para o navegador nem aparece em resposta.
// Cobre exatamente o que o painel antigo fazia direto no banco (ver AUDITORIA-SUPER-ADMIN.md):
//   empresas: listar / criar / editar / ativar / bloquear / confirmar pagamento
//   faturas: listar / marcar vencidas / marcar enviada / marcar paga
//   landing_config: WhatsApp do site e dados do Pix
//   ciclo atual de faturamento (só leitura)
const express = require('express')

// Colunas que o painel lê de "empresas"
const CAMPOS_EMPRESA_LEITURA = 'id, nome_empresa, nome_responsavel, email, whatsapp, status, modulos, documento, plano, trial_inicio, trial_fim, dia_vencimento_fatura, created_at'
// Colunas que o painel pode gravar em "empresas" (as mesmas do formulário atual)
const CAMPOS_EMPRESA_EDITAVEIS = ['nome_empresa', 'nome_responsavel', 'email', 'whatsapp', 'documento', 'plano', 'status', 'trial_inicio', 'trial_fim', 'dia_vencimento_fatura', 'modulos']
// Valores das listas do formulário atual
const STATUS_EMPRESA = ['trial', 'ativo', 'pendente', 'inadimplente', 'bloqueado', 'cancelado', 'inativo']
const PLANOS = ['', 'basico', 'master', 'enterprise', 'interno']
const MODULOS = ['mercadolivre', 'shopee', 'vendas_externas', 'financeiro', 'painel_tv', 'estoque', 'atendimento', 'ranking']
// Faturas
const STATUS_FATURA_ABERTA = ['em_aberto', 'enviada', 'aguardando_pagamento']
const FORMAS_PAGAMENTO = ['Pix', 'Transferência', 'Outro']
// landing_config: só estas chaves
const CHAVES_CONFIG = ['whatsapp_numero', 'pix_beneficiario', 'pix_documento', 'pix_chave', 'pix_banco']

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATA = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const hoje = () => new Date().toISOString().slice(0, 10)

function texto(v, max = 200) {
  if (v === null || v === undefined) return ''
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

// Valida e normaliza os dados de empresa. Devolve { dados } ou { erro }.
function validarEmpresa(corpo, { parcial }) {
  const b = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {}
  const proibidos = Object.keys(b).filter((k) => !CAMPOS_EMPRESA_EDITAVEIS.includes(k))
  if (proibidos.length) return { erro: `Campo(s) não permitido(s): ${proibidos.join(', ')}` }
  const dados = {}
  for (const campo of CAMPOS_EMPRESA_EDITAVEIS) {
    if (!(campo in b)) continue
    const v = b[campo]
    switch (campo) {
      case 'nome_empresa': case 'nome_responsavel': case 'whatsapp': case 'documento':
        dados[campo] = texto(v, campo === 'nome_empresa' ? 120 : 80); break
      case 'email': {
        const e = texto(v, 254).toLowerCase()
        if (e && !EMAIL.test(e)) return { erro: 'E-mail inválido.' }
        dados.email = e; break
      }
      case 'plano': {
        const p = texto(v, 20)
        if (!PLANOS.includes(p)) return { erro: 'Plano inválido.' }
        dados.plano = p; break
      }
      case 'status': {
        const st = texto(v, 20)
        if (!STATUS_EMPRESA.includes(st)) return { erro: 'Status inválido.' }
        dados.status = st; break
      }
      case 'trial_inicio': case 'trial_fim': {
        if (v === null || v === '') { dados[campo] = null; break }
        if (!DATA.test(String(v))) return { erro: `Data inválida em ${campo}.` }
        dados[campo] = String(v); break
      }
      case 'dia_vencimento_fatura': {
        if (v === null || v === '') { dados[campo] = null; break }
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1 || n > 31) return { erro: 'Dia de vencimento deve ser um número entre 1 e 31.' }
        dados[campo] = n; break
      }
      case 'modulos': {
        if (!Array.isArray(v) || v.some((m) => !MODULOS.includes(m))) return { erro: 'Módulos inválidos.' }
        dados.modulos = [...new Set(v)]; break
      }
    }
  }
  if (!parcial) {
    if (!dados.nome_empresa || !dados.email) return { erro: 'Preencha ao menos empresa e e-mail.' }
  } else {
    if ('nome_empresa' in dados && !dados.nome_empresa) return { erro: 'Informe o nome da empresa.' }
    if ('email' in dados && !dados.email) return { erro: 'Informe o e-mail.' }
    if (!Object.keys(dados).length) return { erro: 'Nada para alterar.' }
  }
  return { dados }
}

function criarRotasSuperAdmin({ sb, exigirSuperAdmin, calcularStatusFaturamento, log = console.log }) {
  const r = express.Router()
  r.use('/api/superadmin', exigirSuperAdmin)
  const auditoria = (req, msg) => log(`[SUPERADMIN][auditoria] ${req.superAdmin.id}: ${msg}`)
  const falha = (res, e) => res.status(500).json({ ok: false, error: 'Não foi possível concluir. Tente de novo.' })

  // quem sou (o painel usa para confirmar o acesso logo depois do login)
  r.get('/api/superadmin/sessao', (req, res) => res.json({ ok: true, email: req.superAdmin.email }))

  // ── EMPRESAS ────────────────────────────────────────────────────
  r.get('/api/superadmin/empresas', async (req, res) => {
    const { data, error } = await sb.from('empresas').select(CAMPOS_EMPRESA_LEITURA).order('created_at', { ascending: false })
    if (error) return falha(res, error)
    res.json({ ok: true, empresas: data || [] })
  })

  r.post('/api/superadmin/empresas', async (req, res) => {
    const { dados, erro } = validarEmpresa(req.body, { parcial: false })
    if (erro) return res.status(400).json({ ok: false, error: erro })
    if (!dados.status) dados.status = 'trial'
    const { data, error } = await sb.from('empresas').insert(dados).select(CAMPOS_EMPRESA_LEITURA).single()
    if (error) return falha(res, error)
    auditoria(req, `criou a empresa ${data && data.id}`)
    res.status(201).json({ ok: true, empresa: data })
  })

  r.patch('/api/superadmin/empresas/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ ok: false, error: 'Empresa não encontrada.' })
    const { dados, erro } = validarEmpresa(req.body, { parcial: true })
    if (erro) return res.status(400).json({ ok: false, error: erro })
    const { data: existe } = await sb.from('empresas').select('id').eq('id', req.params.id).maybeSingle()
    if (!existe) return res.status(404).json({ ok: false, error: 'Empresa não encontrada.' })
    const { error } = await sb.from('empresas').update(dados).eq('id', req.params.id)
    if (error) return falha(res, error)
    auditoria(req, `alterou a empresa ${req.params.id}: ${Object.keys(dados).join(', ')}`)
    res.json({ ok: true })
  })

  // ── FATURAS ─────────────────────────────────────────────────────
  // Antes de listar, marca como "vencido" o que passou do vencimento e não foi pago (antes era feito pelo navegador)
  r.get('/api/superadmin/faturas', async (req, res) => {
    const { error: errVencidas } = await sb.from('faturas').update({ status: 'vencido' }).lt('vencimento', hoje()).in('status', STATUS_FATURA_ABERTA)
    if (errVencidas) return falha(res, errVencidas)
    const [fat, emp] = await Promise.all([
      sb.from('faturas').select('*').order('vencimento', { ascending: false }),
      sb.from('empresas').select('id, nome_empresa, whatsapp, status')
    ])
    if (fat.error || emp.error) return falha(res, fat.error || emp.error)
    res.json({ ok: true, faturas: fat.data || [], empresas: emp.data || [] })
  })

  // body: { acao: 'enviada' } | { acao: 'pago', valor_pago, forma_pagamento }
  r.patch('/api/superadmin/faturas/:id', async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ ok: false, error: 'Fatura não encontrada.' })
    const b = req.body || {}
    const { data: fatura } = await sb.from('faturas').select('id, status, valor_total').eq('id', req.params.id).maybeSingle()
    if (!fatura) return res.status(404).json({ ok: false, error: 'Fatura não encontrada.' })
    let alteracao
    if (b.acao === 'enviada') {
      if (['pago', 'cancelado'].includes(fatura.status)) return res.status(409).json({ ok: false, error: 'Esta fatura já está paga ou cancelada.' })
      alteracao = { status: 'enviada' }
    } else if (b.acao === 'pago') {
      if (fatura.status === 'pago') return res.status(409).json({ ok: false, error: 'Esta fatura já está paga.' })
      const forma = texto(b.forma_pagamento, 30)
      if (!FORMAS_PAGAMENTO.includes(forma)) return res.status(400).json({ ok: false, error: 'Forma de pagamento inválida.' })
      let valor = Number(String(b.valor_pago ?? '').replace(',', '.'))
      if (!Number.isFinite(valor) || valor <= 0) valor = Number(fatura.valor_total) // igual ao painel antigo: sem valor → total da fatura
      if (!Number.isFinite(valor) || valor <= 0 || valor > 1e7) return res.status(400).json({ ok: false, error: 'Valor pago inválido.' })
      alteracao = { status: 'pago', data_pagamento: hoje(), valor_pago: Math.round(valor * 100) / 100, forma_pagamento: forma, confirmado_por: 'admin' }
    } else {
      return res.status(400).json({ ok: false, error: 'Ação inválida.' })
    }
    const { error } = await sb.from('faturas').update(alteracao).eq('id', req.params.id)
    if (error) return falha(res, error)
    auditoria(req, `fatura ${req.params.id} → ${alteracao.status}`)
    res.json({ ok: true })
  })

  // ── CONFIGURAÇÕES DO SITE (landing_config) — só as 5 chaves conhecidas ──
  r.get('/api/superadmin/config', async (req, res) => {
    const { data, error } = await sb.from('landing_config').select('chave, valor').in('chave', CHAVES_CONFIG)
    if (error) return falha(res, error)
    const config = {}
    for (const c of CHAVES_CONFIG) config[c] = ''
    for (const linha of data || []) config[linha.chave] = linha.valor || ''
    res.json({ ok: true, config })
  })

  r.patch('/api/superadmin/config', async (req, res) => {
    const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
    const chaves = Object.keys(b)
    const proibidas = chaves.filter((k) => !CHAVES_CONFIG.includes(k))
    if (proibidas.length) return res.status(400).json({ ok: false, error: `Configuração não permitida: ${proibidas.join(', ')}` })
    if (!chaves.length) return res.status(400).json({ ok: false, error: 'Nada para salvar.' })
    const valores = {}
    for (const k of chaves) valores[k] = texto(b[k], 140)
    if ('whatsapp_numero' in valores) {
      valores.whatsapp_numero = valores.whatsapp_numero.replace(/\D/g, '')
      if (valores.whatsapp_numero.length < 12 || valores.whatsapp_numero.length > 15) return res.status(400).json({ ok: false, error: 'Número inválido — inclua DDI (55) e DDD, só números.' })
    }
    for (const [chave, valor] of Object.entries(valores)) {
      // atualiza a linha; se ela ainda não existir, cria (antes, pelo navegador, a gravação sumia sem aviso)
      const { data: atual, error: errLer } = await sb.from('landing_config').select('chave').eq('chave', chave).maybeSingle()
      if (errLer) return falha(res, errLer)
      const { error } = atual
        ? await sb.from('landing_config').update({ valor }).eq('chave', chave)
        : await sb.from('landing_config').insert({ chave, valor })
      if (error) return falha(res, error)
    }
    auditoria(req, `alterou configurações: ${chaves.join(', ')}`)
    res.json({ ok: true })
  })

  // ── CICLO ATUAL (só leitura; mesma lógica da rota de manutenção /api/faturamento/status) ──
  r.get('/api/superadmin/ciclo/:empresaId', async (req, res) => {
    if (!UUID.test(req.params.empresaId)) return res.status(404).json({ ok: false, error: 'Empresa não encontrada' })
    const resultado = await calcularStatusFaturamento(req.params.empresaId)
    if (resultado.http >= 500) return falha(res)
    res.status(resultado.http).json(resultado.json)
  })

  return r
}

module.exports = { criarRotasSuperAdmin, validarEmpresa, CAMPOS_EMPRESA_EDITAVEIS, CHAVES_CONFIG, MODULOS }
