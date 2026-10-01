// Super Admin — assinatura: situação, tolerância, bloqueio automático/manual, pagamento restaura acesso.
// Supabase (banco e Auth) simulados; nada acessa produção.
const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { registro, envTeste, chamar } = require('./helpers')
const A = require('../src/superadmin/assinatura')

const ID_SUPER = '5a5a5a5a-0000-4000-8000-000000000001'
envTeste({ SUPERADMIN_AUTH_IDS: ID_SUPER })
const app = require('../server')
after(() => setTimeout(() => process.exit(0), 50))

const HOJE = A.hojeSP()
const dia = (n) => { const d = new Date(HOJE + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const ctx = { hoje: HOJE, tolerancia: 5 }
const H = { authorization: 'Bearer tok-super' }
const E = { ATIVA: 'e0000000-0000-4000-8000-000000000001', TOL: 'e0000000-0000-4000-8000-000000000002', ATRASO: 'e0000000-0000-4000-8000-000000000003', MANUAL: 'e0000000-0000-4000-8000-000000000004', AUTO: 'e0000000-0000-4000-8000-000000000005', TRIAL: 'e0000000-0000-4000-8000-000000000006', INTERNA: 'e0000000-0000-4000-8000-000000000007' }
const F = (n) => `f0000000-0000-4000-8000-00000000000${n}`
const fatura = (id, empresa_id, vencimento, status = 'em_aberto', extra = {}) => ({ id, empresa_id, vencimento, status, valor_total: 100, periodo_inicio: dia(-40), periodo_fim: vencimento, ...extra })
const logins = () => registro.auth.chamadas.filter((c) => c[0] === 'update').map((c) => [c[1], c[2].ban_duration])

beforeEach(() => {
  registro.ops.length = 0
  registro.dados = {}
  registro.auth = { tokens: { 'tok-super': ID_SUPER }, chamadas: [], erro: null }
  registro.db = {
    empresas: [
      { id: E.ATIVA, nome_empresa: 'Ativa', status: 'ativo', plano: 'master', whatsapp: '(16) 99999-0001', created_at: '2026-01-01' },
      { id: E.TOL, nome_empresa: 'Tolerancia', status: 'ativo', plano: 'master', created_at: '2026-01-02' },
      { id: E.ATRASO, nome_empresa: 'Atrasada', status: 'ativo', plano: 'master', created_at: '2026-01-03' },
      { id: E.MANUAL, nome_empresa: 'Manual', status: 'bloqueado', bloqueio_origem: 'manual', bloqueado_em: '2026-09-01T10:00:00Z', plano: 'master', created_at: '2026-01-04' },
      { id: E.AUTO, nome_empresa: 'Auto', status: 'bloqueado', bloqueio_origem: 'inadimplencia', plano: 'master', created_at: '2026-01-05' },
      { id: E.TRIAL, nome_empresa: 'Trial', status: 'trial', plano: '', trial_inicio: dia(-3), trial_fim: dia(4), created_at: '2026-01-06' },
      { id: E.INTERNA, nome_empresa: 'Interna', status: 'ativo', plano: 'interno', created_at: '2026-01-07' }
    ],
    faturas: [
      fatura(F(1), E.ATIVA, dia(-20), 'pago', { data_pagamento: dia(-19), valor_pago: 100, forma_pagamento: 'Pix' }),
      fatura(F(2), E.TOL, dia(-3)),
      fatura(F(3), E.ATRASO, dia(-9)),
      fatura(F(4), E.MANUAL, dia(-10)),
      fatura(F(5), E.AUTO, dia(-12)),
      fatura(F(6), E.INTERNA, dia(-30))
    ],
    users: [
      { id: 'u1', auth_id: 'auth-atraso-1', empresa_id: E.ATRASO, active: true },
      { id: 'u2', auth_id: 'auth-atraso-2', empresa_id: E.ATRASO, active: false }, // já desativado pela empresa: nunca é liberado aqui
      { id: 'u3', auth_id: null, empresa_id: E.ATRASO, active: true }, // usuário antigo sem conta no Auth
      { id: 'u4', auth_id: 'auth-manual', empresa_id: E.MANUAL, active: true },
      { id: 'u5', auth_id: 'auth-auto', empresa_id: E.AUTO, active: true },
      { id: 'u6', auth_id: 'auth-ativa', empresa_id: E.ATIVA, active: true }
    ]
  }
})
const empresa = (id) => registro.db.empresas.find((e) => e.id === id)
const req = async (metodo, caminho, body) => { const r = await chamar(app, metodo, caminho, { headers: H, body }); let json = null; try { json = JSON.parse(r.texto) } catch (_) {}; return { ...r, json } }

// ── 1. Regras puras ─────────────────────────────────────────────────
test('dias de atraso e tolerância: 0 → em dia; 1..5 → tolerância; 6 → passa da tolerância', () => {
  const emp = { id: 'x', status: 'ativo', plano: 'master' }
  const sit = (venc) => A.calcularSituacao(emp, [fatura('f', 'x', venc)], ctx)
  assert.equal(sit(HOJE).codigo, 'ativo'); assert.equal(sit(HOJE).diasAtraso, 0)
  assert.equal(sit(dia(-1)).codigo, 'em_tolerancia'); assert.equal(sit(dia(-1)).diasAtraso, 1); assert.equal(sit(dia(-1)).diasToleranciaRestantes, 4)
  assert.equal(sit(dia(-5)).codigo, 'em_tolerancia'); assert.equal(sit(dia(-5)).deveBloquear, false)
  assert.equal(sit(dia(-6)).codigo, 'em_atraso'); assert.equal(sit(dia(-6)).diasAtraso, 6); assert.equal(sit(dia(-6)).deveBloquear, true)
})
test('fatura paga ou cancelada não conta como atraso', () => {
  const emp = { id: 'x', status: 'ativo', plano: 'master' }
  assert.equal(A.calcularSituacao(emp, [fatura('f', 'x', dia(-30), 'pago')], ctx).diasAtraso, 0)
  assert.equal(A.calcularSituacao(emp, [fatura('f', 'x', dia(-30), 'cancelado')], ctx).diasAtraso, 0)
  assert.equal(A.calcularSituacao(emp, [fatura('f', 'x', dia(-30), 'vencido')], ctx).diasAtraso, 30)
})
test('interno, cancelado e inativo nunca são bloqueados automaticamente', () => {
  for (const emp of [{ id: 'x', status: 'ativo', plano: 'interno' }, { id: 'x', status: 'cancelado' }, { id: 'x', status: 'inativo' }]) {
    const s = A.calcularSituacao(emp, [fatura('f', 'x', dia(-40))], ctx)
    assert.equal(s.deveBloquear, false, JSON.stringify(emp))
  }
})
test('bloqueio manual: pagamento não reativa; bloqueio por inadimplência: reativa quando não há atraso além da tolerância', () => {
  assert.equal(A.calcularSituacao({ id: 'x', status: 'bloqueado', bloqueio_origem: 'manual' }, [], ctx).podeReativarSozinha, false)
  assert.equal(A.calcularSituacao({ id: 'x', status: 'bloqueado', bloqueio_origem: 'inadimplencia' }, [], ctx).podeReativarSozinha, true)
  assert.equal(A.calcularSituacao({ id: 'x', status: 'bloqueado', bloqueio_origem: 'inadimplencia' }, [fatura('f', 'x', dia(-9))], ctx).podeReativarSozinha, false)
  assert.equal(A.calcularSituacao({ id: 'x', status: 'bloqueado' }, [], ctx).bloqueioOrigem, 'manual', 'bloqueado sem origem (antigo) = manual')
})
test('trial: dias restantes e fim do trial', () => {
  const s = A.calcularSituacao({ id: 'x', status: 'trial', trial_inicio: dia(-3), trial_fim: dia(4) }, [], ctx)
  assert.equal(s.codigo, 'trial'); assert.equal(s.trial.diasRestantes, 4); assert.equal(s.trial.encerrado, false)
  const acabou = A.calcularSituacao({ id: 'x', status: 'trial', trial_fim: dia(-1) }, [], ctx)
  assert.notEqual(acabou.codigo, 'trial'); assert.equal(acabou.trial.encerrado, true)
  assert.equal(acabou.proximoVencimento, A.proximoVencimento({ status: 'trial', trial_fim: dia(-1) }, HOJE))
})
test('próximo vencimento segue as regras do fechamento (trial_fim + 30; depois o dia fixo)', () => {
  assert.equal(A.proximoVencimento({ status: 'trial', trial_fim: '2026-09-01' }, '2026-09-10'), '2026-10-01')
  assert.equal(A.proximoVencimento({ status: 'ativo', dia_vencimento_fatura: 15, ultimo_fechamento: '2026-09-15' }, '2026-09-20'), '2026-10-15')
  assert.equal(A.proximoVencimento({ status: 'ativo', dia_vencimento_fatura: 20, ultimo_fechamento: '2026-09-20' }, '2026-09-20'), '2026-10-20')
  assert.equal(A.proximoVencimento({ status: 'ativo', plano: 'interno', dia_vencimento_fatura: 5 }, '2026-09-20'), null)
  assert.equal(A.diasEntre('2026-09-30', '2026-10-02'), 2)
})
test('resumo: números vêm das faturas reais', () => {
  const mes = HOJE.slice(0, 7)
  const empresas = [{ id: 'a', status: 'ativo' }, { id: 'b', status: 'ativo' }, { id: 'c', status: 'cancelado' }]
  const faturas = [fatura('1', 'a', HOJE, 'em_aberto', { valor_total: 50 }), fatura('2', 'b', dia(-2), 'vencido', { valor_total: 70 }),
    fatura('3', 'a', dia(-40), 'pago', { valor_total: 30, valor_pago: 30, data_pagamento: HOJE })]
  const r = A.calcularResumo(empresas, faturas, ctx)
  assert.equal(r.clientes.total, 3); assert.equal(r.clientes.cancelados, 1); assert.equal(r.clientes.emTolerancia, 1)
  assert.equal(r.financeiro.aReceber, 50); assert.equal(r.financeiro.emAtraso, 70); assert.equal(r.financeiro.recebidoNoMes, 30)
  assert.equal(r.mes, mes)
})
test('tolerância: TOLERANCIA_DIAS inválida volta para 5', () => {
  assert.equal(A.lerTolerancia(undefined), 5); assert.equal(A.lerTolerancia('abc'), 5); assert.equal(A.lerTolerancia('7'), 7); assert.equal(A.lerTolerancia('-1'), 5)
})

// ── 2. Verificação automática (o backend é a autoridade) ───────────
test('verificação: bloqueia quem passou da tolerância, suspende o login dos ativos com conta no Auth, não apaga nada', async () => {
  const antes = JSON.stringify(registro.db.faturas.map((f) => f.id))
  const ass = A.criarAssinatura({ sb: require('@supabase/supabase-js').createClient(), tolerancia: 5, log: () => {} })
  const r = await ass.verificar()
  assert.deepEqual(r.bloqueadas, [E.ATRASO])
  assert.equal(empresa(E.ATRASO).status, 'bloqueado'); assert.equal(empresa(E.ATRASO).bloqueio_origem, 'inadimplencia'); assert.ok(empresa(E.ATRASO).bloqueado_em)
  assert.deepEqual(logins().filter((l) => l[0].startsWith('auth-atraso')), [['auth-atraso-1', '876000h']], 'só o usuário ativo com Auth')
  assert.equal(empresa(E.TOL).status, 'ativo', 'em tolerância continua com acesso')
  assert.equal(empresa(E.INTERNA).status, 'ativo', 'interna nunca é bloqueada')
  assert.equal(empresa(E.MANUAL).status, 'bloqueado'); assert.equal(empresa(E.MANUAL).bloqueio_origem, 'manual')
  assert.equal(JSON.stringify(registro.db.faturas.map((f) => f.id)), antes, 'nenhuma fatura apagada')
  assert.equal(registro.db.empresas.length, 7, 'nenhuma empresa apagada')
  assert.equal(registro.db.faturas.find((f) => f.id === F(3)).status, 'vencido', 'fatura vencida marcada pelo backend')
})
test('verificação é repetível: rodar de novo não bloqueia duas vezes e reaplica a suspensão dos bloqueados', async () => {
  const ass = A.criarAssinatura({ sb: require('@supabase/supabase-js').createClient(), tolerancia: 5, log: () => {} })
  await ass.verificar(); const r2 = await ass.verificar()
  assert.deepEqual(r2.bloqueadas, []); assert.ok(r2.loginsReaplicados >= 1)
})

// ── 3. Rotas ────────────────────────────────────────────────────────
test('GET /empresas traz a situação calculada pelo backend (WhatsApp real, atraso, tolerância, trial)', async () => {
  const r = await req('GET', '/api/superadmin/empresas')
  assert.equal(r.status, 200)
  const por = Object.fromEntries(r.json.empresas.map((e) => [e.id, e]))
  assert.equal(por[E.ATIVA].whatsapp, '(16) 99999-0001')
  assert.equal(por[E.ATIVA].situacao.codigo, 'ativo'); assert.equal(por[E.ATIVA].situacao.ultimoPagamento.forma, 'Pix')
  assert.equal(por[E.TOL].situacao.codigo, 'em_tolerancia'); assert.equal(por[E.TOL].situacao.diasAtraso, 3)
  assert.equal(por[E.ATRASO].situacao.codigo, 'em_atraso'); assert.equal(por[E.ATRASO].situacao.diasAtraso, 9)
  assert.equal(por[E.MANUAL].situacao.bloqueioOrigem, 'manual'); assert.equal(por[E.AUTO].situacao.bloqueioOrigem, 'inadimplencia')
  assert.equal(por[E.TRIAL].situacao.codigo, 'trial'); assert.equal(por[E.TRIAL].situacao.trial.diasRestantes, 4)
  assert.equal(r.json.toleranciaDias, 5); assert.equal(r.json.migracaoPendente, false)
  assert.ok(!('deveBloquear' in por[E.ATRASO].situacao), 'decisão interna não vai para o navegador')
})
test('GET /resumo: contagens e valores reais', async () => {
  const r = await req('GET', '/api/superadmin/resumo')
  assert.equal(r.status, 200)
  const c = r.json.resumo.clientes
  assert.equal(c.total, 7); assert.equal(c.ativos, 1); assert.equal(c.emTolerancia, 1); assert.equal(c.emAtraso, 1); assert.equal(c.bloqueados, 2); assert.equal(c.trial, 1); assert.equal(c.internos, 1)
  assert.equal(r.json.resumo.financeiro.emAtraso, 500)
})
test('bloqueio manual: imediato, grava origem manual e suspende o login', async () => {
  const r = await req('POST', `/api/superadmin/empresas/${E.ATIVA}/bloquear`, {})
  assert.equal(r.status, 200)
  assert.equal(empresa(E.ATIVA).status, 'bloqueado'); assert.equal(empresa(E.ATIVA).bloqueio_origem, 'manual')
  assert.deepEqual(logins(), [['auth-ativa', '876000h']])
  assert.ok(registro.logs.some((l) => l.includes('[auditoria]') && l.includes('BLOQUEOU manualmente')))
})
test('ativação manual: libera o login e limpa a origem', async () => {
  const r = await req('POST', `/api/superadmin/empresas/${E.MANUAL}/ativar`, {})
  assert.equal(r.status, 200)
  assert.equal(empresa(E.MANUAL).status, 'ativo'); assert.equal(empresa(E.MANUAL).bloqueio_origem, null); assert.equal(empresa(E.MANUAL).bloqueado_em, null)
  assert.deepEqual(logins(), [['auth-manual', 'none']])
  assert.match(r.json.aviso, /vencida há 10 dia/, 'avisa que a verificação diária bloqueia de novo sem pagamento')
})
test('pagamento da fatura atrasada restaura o acesso (bloqueio por inadimplência)', async () => {
  const r = await req('PATCH', `/api/superadmin/faturas/${F(5)}`, { acao: 'pago', valor_pago: '100', forma_pagamento: 'Pix' })
  assert.equal(r.status, 200); assert.equal(r.json.acessoRestaurado, true)
  const f = registro.db.faturas.find((x) => x.id === F(5))
  assert.equal(f.status, 'pago'); assert.equal(f.forma_pagamento, 'Pix'); assert.equal(f.data_pagamento, HOJE)
  assert.equal(empresa(E.AUTO).status, 'ativo'); assert.equal(empresa(E.AUTO).bloqueio_origem, null)
  assert.deepEqual(logins(), [['auth-auto', 'none']])
})
test('pagamento NÃO reativa empresa bloqueada manualmente', async () => {
  const r = await req('PATCH', `/api/superadmin/faturas/${F(4)}`, { acao: 'pago', forma_pagamento: 'Pix' })
  assert.equal(r.status, 200); assert.equal(r.json.acessoRestaurado, false)
  assert.equal(empresa(E.MANUAL).status, 'bloqueado'); assert.equal(empresa(E.MANUAL).bloqueio_origem, 'manual')
  assert.deepEqual(logins(), [])
})
test('fatura paga não pode ser paga de novo (e fatura cancelada não pode ser paga)', async () => {
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${F(1)}`, { acao: 'pago', forma_pagamento: 'Pix' })).status, 409)
  registro.db.faturas.find((x) => x.id === F(2)).status = 'cancelado'
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${F(2)}`, { acao: 'pago', forma_pagamento: 'Pix' })).status, 409)
  const f1 = registro.db.faturas.find((x) => x.id === F(1))
  assert.equal(f1.data_pagamento, dia(-19), 'pagamento original preservado')
})
test('duas confirmações ao mesmo tempo: só uma grava', async () => {
  const [a, b] = await Promise.all([
    req('PATCH', `/api/superadmin/faturas/${F(3)}`, { acao: 'pago', forma_pagamento: 'Pix', valor_pago: '100' }),
    req('PATCH', `/api/superadmin/faturas/${F(3)}`, { acao: 'pago', forma_pagamento: 'Transferência', valor_pago: '100' })
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
})
test('corrida real: a checagem viu "em aberto", mas outra confirmação gravou antes → 409 e nada é sobrescrito', async () => {
  const f = registro.db.faturas.find((x) => x.id === F(3))
  let leituras = 0; let status = 'em_aberto'; let dataPag = dia(-1)
  Object.defineProperty(f, 'status', { get: () => (++leituras === 1 ? 'em_aberto' : (status = 'pago')), set: (v) => { status = v }, enumerable: true, configurable: true })
  Object.defineProperty(f, 'data_pagamento', { get: () => dataPag, set: (v) => { dataPag = v }, enumerable: true, configurable: true })
  const r = await req('PATCH', `/api/superadmin/faturas/${F(3)}`, { acao: 'pago', forma_pagamento: 'Transferência', valor_pago: '100' })
  assert.equal(r.status, 409)
  assert.equal(dataPag, dia(-1), 'o pagamento que chegou primeiro não foi sobrescrito')
})
test('data do pagamento: aceita data passada, recusa futura e inválida', async () => {
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${F(2)}`, { acao: 'pago', forma_pagamento: 'Pix', data_pagamento: dia(1) })).status, 400)
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${F(2)}`, { acao: 'pago', forma_pagamento: 'Pix', data_pagamento: '2026-02-31x' })).status, 400)
  assert.equal(registro.db.faturas.find((x) => x.id === F(2)).status, 'em_aberto', 'nada gravado')
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${F(2)}`, { acao: 'pago', forma_pagamento: 'Pix', data_pagamento: dia(-1) })).status, 200)
  assert.equal(registro.db.faturas.find((x) => x.id === F(2)).data_pagamento, dia(-1))
})
test('editar status pelo formulário: "bloqueado" suspende o login (manual) e sair de "bloqueado" libera', async () => {
  assert.equal((await req('PATCH', `/api/superadmin/empresas/${E.ATIVA}`, { status: 'bloqueado' })).status, 200)
  assert.equal(empresa(E.ATIVA).bloqueio_origem, 'manual')
  assert.equal((await req('PATCH', `/api/superadmin/empresas/${E.ATIVA}`, { status: 'ativo', nome_empresa: 'Ativa 2' })).status, 200)
  assert.equal(empresa(E.ATIVA).status, 'ativo'); assert.equal(empresa(E.ATIVA).nome_empresa, 'Ativa 2')
  assert.deepEqual(logins(), [['auth-ativa', '876000h'], ['auth-ativa', 'none']])
})
test('rotas novas exigem Super Admin (sem token → 401)', async () => {
  for (const [m, c] of [['GET', '/api/superadmin/resumo'], ['POST', `/api/superadmin/empresas/${E.ATIVA}/bloquear`], ['POST', `/api/superadmin/empresas/${E.MANUAL}/ativar`]]) {
    const r = await chamar(app, m, c, { body: m === 'POST' ? {} : undefined })
    assert.equal(r.status, 401, c)
  }
  assert.equal(empresa(E.ATIVA).status, 'ativo'); assert.equal(empresa(E.MANUAL).status, 'bloqueado')
})

// ── 4. SQL 09 ainda não rodou: nada quebra e nada é bloqueado ───────
test('sem as colunas novas: listagem funciona (migracaoPendente), bloqueio responde 503 e a verificação não bloqueia ninguém', async () => {
  const semColuna = { code: '42703', message: 'column empresas.bloqueio_origem does not exist' }
  const sbReal = require('@supabase/supabase-js').createClient()
  const sb = { ...sbReal, from: (t) => {
    const q = sbReal.from(t)
    if (t !== 'empresas') return q
    const select = q.select; const update = q.update
    q.select = (cols, ...r) => { if (String(cols || '').includes('bloqueio_origem')) q.erroColuna = true; return select(cols, ...r) }
    q.update = (p, ...r) => { if (p && 'bloqueio_origem' in p) q.erroColuna = true; return update(p, ...r) }
    const then = q.then; q.then = (ok, f) => (q.erroColuna ? Promise.resolve({ data: null, error: semColuna }).then(ok, f) : then(ok, f))
    return q
  } }
  const ass = A.criarAssinatura({ sb, tolerancia: 5, log: () => {} })
  await assert.rejects(() => ass.verificar(), A.MigracaoPendente)
  await assert.rejects(() => ass.bloquear(E.ATIVA, 'manual'), A.MigracaoPendente)
  assert.equal(empresa(E.ATRASO).status, 'ativo'); assert.equal(empresa(E.ATIVA).status, 'ativo')
  assert.deepEqual(logins(), [], 'nenhum login suspenso')
  const { criarRotasSuperAdmin } = require('../src/superadmin/rotas')
  const express = require('express'); const mini = express(); mini.use(express.json())
  mini.use(criarRotasSuperAdmin({ sb, exigirSuperAdmin: (q, s, n) => { q.superAdmin = { id: 'x' }; n() }, calcularStatusFaturamento: async () => ({ http: 200, json: {} }), assinatura: ass, log: () => {} }))
  const lista = await chamar(mini, 'GET', '/api/superadmin/empresas')
  assert.equal(lista.status, 200); assert.equal(JSON.parse(lista.texto).migracaoPendente, true)
  const bloq = await chamar(mini, 'POST', `/api/superadmin/empresas/${E.ATIVA}/bloquear`, { body: {} })
  assert.equal(bloq.status, 503); assert.match(bloq.texto, /SQL 09/)
})
