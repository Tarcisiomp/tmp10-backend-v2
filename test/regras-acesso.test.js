// Super Admin V4 — REGRAS FINAIS DE ACESSO (ajustes finais).
//   ativo / trial válido / em tolerância → login permitido
//   bloqueado (inadimplência ou manual) / inativo / cancelado → login suspenso
//   pagamento reativa SÓ bloqueio por inadimplência; manual, inativo e cancelado só pelo Super Admin
//   bloqueio é de ACESSO: as faturas continuam sendo geradas pela regra existente
// Supabase (banco e Auth) simulados; nada acessa produção.
const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { registro, envTeste, chamar, TOKEN_ADMIN } = require('./helpers')
const A = require('../src/superadmin/assinatura')

const ID_SUPER = '5a5a5a5a-0000-4000-8000-000000000001'
envTeste({ SUPERADMIN_AUTH_IDS: ID_SUPER })
const app = require('../server')
after(() => setTimeout(() => process.exit(0), 50))

const HOJE = A.hojeSP()
const dia = (n) => { const d = new Date(HOJE + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const H = { authorization: 'Bearer tok-super' }
const E = {
  ATIVO: 'e1000000-0000-4000-8000-000000000001', TRIAL: 'e1000000-0000-4000-8000-000000000002', TOL: 'e1000000-0000-4000-8000-000000000003',
  INAD: 'e1000000-0000-4000-8000-000000000004', MANUAL: 'e1000000-0000-4000-8000-000000000005', INATIVO: 'e1000000-0000-4000-8000-000000000006',
  CANCELADO: 'e1000000-0000-4000-8000-000000000007', ATRASADO: 'e1000000-0000-4000-8000-000000000008'
}
const F = { TOL: 'f1000000-0000-4000-8000-000000000003', INAD: 'f1000000-0000-4000-8000-000000000004', MANUAL: 'f1000000-0000-4000-8000-000000000005',
  INATIVO: 'f1000000-0000-4000-8000-000000000006', CANCELADO: 'f1000000-0000-4000-8000-000000000007', ATRASADO: 'f1000000-0000-4000-8000-000000000008' }
const fatura = (id, empresa_id, vencimento) => ({ id, empresa_id, vencimento, status: 'em_aberto', valor_total: 100, periodo_inicio: dia(-40), periodo_fim: vencimento })
const AUTH = (k) => `auth-${k.toLowerCase()}`

beforeEach(() => {
  registro.ops.length = 0
  registro.dados = {}
  registro.auth = { tokens: { 'tok-super': ID_SUPER }, chamadas: [], erro: null }
  registro.db = {
    empresas: [
      { id: E.ATIVO, nome_empresa: 'Ativo', status: 'ativo', plano: 'master', created_at: '2026-01-01' },
      { id: E.TRIAL, nome_empresa: 'Trial', status: 'trial', plano: '', trial_inicio: dia(-2), trial_fim: dia(5), created_at: '2026-01-02' },
      { id: E.TOL, nome_empresa: 'Tolerancia', status: 'ativo', plano: 'master', created_at: '2026-01-03' },
      { id: E.INAD, nome_empresa: 'Inadimplente', status: 'bloqueado', bloqueio_origem: 'inadimplencia', bloqueado_em: '2026-09-01T09:30:00Z', plano: 'master', created_at: '2026-01-04' },
      { id: E.MANUAL, nome_empresa: 'Manual', status: 'bloqueado', bloqueio_origem: 'manual', bloqueado_em: '2026-09-01T09:30:00Z', plano: 'master', created_at: '2026-01-05' },
      { id: E.INATIVO, nome_empresa: 'Inativa', status: 'inativo', plano: 'master', created_at: '2026-01-06' },
      { id: E.CANCELADO, nome_empresa: 'Cancelada', status: 'cancelado', plano: 'master', created_at: '2026-01-07' },
      { id: E.ATRASADO, nome_empresa: 'Atrasada', status: 'ativo', plano: 'master', created_at: '2026-01-08' }
    ],
    faturas: [
      fatura(F.TOL, E.TOL, dia(-4)), fatura(F.INAD, E.INAD, dia(-9)), fatura(F.MANUAL, E.MANUAL, dia(-9)),
      fatura(F.INATIVO, E.INATIVO, dia(-20)), fatura(F.CANCELADO, E.CANCELADO, dia(-20)), fatura(F.ATRASADO, E.ATRASADO, dia(-6))
    ],
    users: Object.entries(E).map(([k, id]) => ({ id: 'u-' + k, auth_id: AUTH(k), empresa_id: id, active: true }))
  }
})
const empresa = (id) => registro.db.empresas.find((e) => e.id === id)
const banidos = () => registro.auth.chamadas.filter((c) => c[0] === 'update' && c[2].ban_duration !== 'none').map((c) => c[1])
const liberados = () => registro.auth.chamadas.filter((c) => c[0] === 'update' && c[2].ban_duration === 'none').map((c) => c[1])
const req = async (metodo, caminho, body) => { const r = await chamar(app, metodo, caminho, { headers: H, body }); let json = null; try { json = JSON.parse(r.texto) } catch (_) {}; return { ...r, json } }
const situacoes = async () => Object.fromEntries((await req('GET', '/api/superadmin/empresas')).json.empresas.map((e) => [e.id, e.situacao]))
const verificar = () => A.criarAssinatura({ sb: require('@supabase/supabase-js').createClient(), tolerancia: 5, log: () => {} }).verificar()
const pagar = (id) => req('PATCH', `/api/superadmin/faturas/${id}`, { acao: 'pago', forma_pagamento: 'Pix', valor_pago: '100' })

test('1-3 — ATIVO, TRIAL válido e EM TOLERÂNCIA: login permitido (backend informa e a verificação diária não suspende)', async () => {
  const s = await situacoes()
  assert.deepEqual([s[E.ATIVO].acessoPermitido, s[E.TRIAL].acessoPermitido, s[E.TOL].acessoPermitido], [true, true, true])
  assert.deepEqual([s[E.ATIVO].codigo, s[E.TRIAL].codigo, s[E.TOL].codigo], ['ativo', 'trial', 'em_tolerancia'])
  await verificar()
  for (const k of ['ATIVO', 'TRIAL', 'TOL']) assert.ok(!banidos().includes(AUTH(k)), `${k} não pode ter o login suspenso`)
  assert.deepEqual(liberados(), [])
})

test('4 — BLOQUEADO por inadimplência: login bloqueado (6º dia → bloqueio automático + suspensão; já bloqueada → suspensão reaplicada)', async () => {
  const s = await situacoes()
  assert.equal(s[E.INAD].acessoPermitido, false)
  const r = await verificar()
  assert.deepEqual(r.bloqueadas, [E.ATRASADO], '6 dias de atraso → bloqueio automático')
  assert.deepEqual([empresa(E.ATRASADO).status, empresa(E.ATRASADO).bloqueio_origem], ['bloqueado', 'inadimplencia'])
  assert.ok(banidos().includes(AUTH('ATRASADO'))); assert.ok(banidos().includes(AUTH('INAD')))
})

test('5 — BLOQUEADO por inadimplência + pagamento → volta para ATIVO e o login é liberado', async () => {
  const r = await pagar(F.INAD)
  assert.equal(r.status, 200); assert.equal(r.json.acessoRestaurado, true)
  assert.deepEqual([empresa(E.INAD).status, empresa(E.INAD).bloqueio_origem, empresa(E.INAD).bloqueado_em], ['ativo', null, null])
  assert.deepEqual(liberados(), [AUTH('INAD')])
})

test('6 — BLOQUEADO manualmente + pagamento → continua BLOQUEADO (manual)', async () => {
  const r = await pagar(F.MANUAL)
  assert.equal(r.status, 200); assert.equal(r.json.acessoRestaurado, false)
  assert.deepEqual([empresa(E.MANUAL).status, empresa(E.MANUAL).bloqueio_origem], ['bloqueado', 'manual'])
  assert.deepEqual(liberados(), [])
})

test('7 — BLOQUEADO manualmente + botão ATIVAR → ATIVO, origem e data limpas, login liberado', async () => {
  const r = await req('POST', `/api/superadmin/empresas/${E.MANUAL}/ativar`, {})
  assert.equal(r.status, 200)
  assert.deepEqual([empresa(E.MANUAL).status, empresa(E.MANUAL).bloqueio_origem, empresa(E.MANUAL).bloqueado_em], ['ativo', null, null])
  assert.deepEqual(liberados(), [AUTH('MANUAL')])
})

test('8 — INATIVO: login bloqueado (a verificação suspende os usuários SEM mudar a empresa no banco; mudar para inativo pelo painel também suspende)', async () => {
  assert.equal((await situacoes())[E.INATIVO].acessoPermitido, false)
  const antes = JSON.stringify(empresa(E.INATIVO))
  await verificar()
  assert.ok(banidos().includes(AUTH('INATIVO')))
  assert.equal(JSON.stringify(empresa(E.INATIVO)), antes, 'empresa inativa não é alterada no banco')
  registro.auth.chamadas.length = 0
  assert.equal((await req('PATCH', `/api/superadmin/empresas/${E.ATIVO}`, { status: 'inativo' })).status, 200)
  assert.equal(empresa(E.ATIVO).status, 'inativo'); assert.deepEqual(banidos(), [AUTH('ATIVO')])
})

test('9 — INATIVO + pagamento → continua INATIVO e o login continua suspenso', async () => {
  const r = await pagar(F.INATIVO)
  assert.equal(r.status, 200); assert.equal(r.json.acessoRestaurado, false)
  assert.equal(empresa(E.INATIVO).status, 'inativo'); assert.deepEqual(liberados(), [])
})

test('10 — CANCELADO: login bloqueado (verificação e mudança pelo painel)', async () => {
  assert.equal((await situacoes())[E.CANCELADO].acessoPermitido, false)
  await verificar()
  assert.ok(banidos().includes(AUTH('CANCELADO')))
  assert.equal(empresa(E.CANCELADO).status, 'cancelado')
  registro.auth.chamadas.length = 0
  assert.equal((await req('PATCH', `/api/superadmin/empresas/${E.TRIAL}`, { status: 'cancelado' })).status, 200)
  assert.deepEqual(banidos(), [AUTH('TRIAL')])
})

test('11 — CANCELADO + pagamento → continua CANCELADO; só o Super Admin reativa (Ativar ou mudar o status)', async () => {
  const r = await pagar(F.CANCELADO)
  assert.equal(r.json.acessoRestaurado, false); assert.equal(empresa(E.CANCELADO).status, 'cancelado'); assert.deepEqual(liberados(), [])
  assert.equal((await req('POST', `/api/superadmin/empresas/${E.CANCELADO}/ativar`, {})).status, 200)
  assert.equal(empresa(E.CANCELADO).status, 'ativo'); assert.deepEqual(liberados(), [AUTH('CANCELADO')])
  registro.auth.chamadas.length = 0
  assert.equal((await req('PATCH', `/api/superadmin/empresas/${E.INATIVO}`, { status: 'trial' })).status, 200)
  assert.equal(empresa(E.INATIVO).status, 'trial'); assert.deepEqual(liberados(), [AUTH('INATIVO')])
})

test('12 — geração de faturas: BLOQUEADO continua gerando; CANCELADO e INATIVO não geram; histórico intacto', async () => {
  const hojeUTC = new Date().toISOString().slice(0, 10)
  const menos = (n) => { const d = new Date(hojeUTC + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10) }
  for (const id of [E.INAD, E.INATIVO, E.CANCELADO]) Object.assign(empresa(id), { trial_fim: menos(40), dia_vencimento_fatura: null })
  const historico = JSON.stringify(registro.db.faturas)
  const antes = registro.db.faturas.length
  const r = await chamar(app, 'GET', '/api/faturamento/processar-fechamentos', { headers: { 'x-admin-token': TOKEN_ADMIN } })
  assert.equal(r.status, 200)
  const novas = registro.db.faturas.slice(antes)
  assert.ok(novas.some((f) => f.empresa_id === E.INAD && f.status === 'em_aberto'), 'bloqueado (inadimplência) continua gerando fatura')
  assert.ok(!novas.some((f) => f.empresa_id === E.CANCELADO), 'cancelado NÃO gera fatura nova')
  assert.ok(!novas.some((f) => f.empresa_id === E.INATIVO), 'inativo NÃO gera fatura nova')
  assert.equal(empresa(E.INAD).status, 'bloqueado', 'gerar fatura não muda o bloqueio')
  assert.equal(JSON.stringify(registro.db.faturas.slice(0, antes)), historico, 'faturas antigas (inclusive da cancelada) não mudam nem somem')
  assert.equal(registro.db.faturas.find((f) => f.id === F.CANCELADO).status, 'em_aberto', 'fatura antiga da cancelada NÃO é cancelada automaticamente')
})
test('12b — geração manual (rota de manutenção) também não cria fatura para empresa CANCELADA; para bloqueada cria', async () => {
  const antes = registro.db.faturas.length
  const q = '?periodoInicio=2026-01-01&periodoFim=2026-01-31'
  assert.equal((await chamar(app, 'GET', `/api/faturamento/gerar-fatura/${E.CANCELADO}${q}`, { headers: { 'x-admin-token': TOKEN_ADMIN } })).status, 200)
  assert.equal(registro.db.faturas.length, antes, 'cancelada: nada criado')
  assert.ok(registro.logs.some((l) => l.includes('está CANCELADA — nenhuma fatura nova gerada')))
  await chamar(app, 'GET', `/api/faturamento/gerar-fatura/${E.MANUAL}${q}`, { headers: { 'x-admin-token': TOKEN_ADMIN } })
  assert.equal(registro.db.faturas.length, antes + 1, 'bloqueada (manual): fatura criada')
})

test('13 — fatura já paga não pode ser paga novamente', async () => {
  assert.equal((await pagar(F.INAD)).status, 200)
  const r = await pagar(F.INAD)
  assert.equal(r.status, 409); assert.match(r.json.error, /já está paga/)
})

test('15 — nenhum dado é apagado pelo bloqueio, desbloqueio, inativação ou pagamento', async () => {
  const contagem = () => ({ empresas: registro.db.empresas.length, faturas: registro.db.faturas.length, users: registro.db.users.length })
  const antes = contagem()
  const camposAntes = Object.fromEntries(registro.db.empresas.map((e) => [e.id, Object.keys(e).filter((k) => !['status', 'bloqueio_origem', 'bloqueado_em'].includes(k)).map((k) => `${k}=${e[k]}`).join('|')]))
  await verificar()
  await req('POST', `/api/superadmin/empresas/${E.ATIVO}/bloquear`, {})
  await req('POST', `/api/superadmin/empresas/${E.ATIVO}/ativar`, {})
  await req('PATCH', `/api/superadmin/empresas/${E.TRIAL}`, { status: 'inativo' })
  await pagar(F.INAD)
  assert.deepEqual(contagem(), antes)
  for (const e of registro.db.empresas) {
    assert.equal(Object.keys(e).filter((k) => !['status', 'bloqueio_origem', 'bloqueado_em'].includes(k)).map((k) => `${k}=${e[k]}`).join('|'), camposAntes[e.id], `dados da empresa ${e.nome_empresa} mudaram`)
  }
  assert.ok(!registro.ops.some((o) => o.acao === 'delete'), 'nenhuma exclusão')
  assert.ok(registro.db.users.every((u) => u.active === true), 'usuários não são desativados na tabela (só o login no Auth)')
})
