// Integração V4 (Super Admin / assinatura) + 0.4 (conta central do ERP) no MESMO servidor.
// Supabase (banco e Auth) simulados; nada acessa produção.
const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { registro, envTeste, chamar } = require('./helpers')

const ID_SUPER = '5a5a5a5a-0000-4000-8000-000000000001'
envTeste({ SUPERADMIN_AUTH_IDS: ID_SUPER })
const app = require('../server')
after(() => setTimeout(() => process.exit(0), 50))

const EMP = 'e4000000-0000-4000-8000-000000000001'
const SA = { authorization: 'Bearer tok-super' }
const ADM = { authorization: 'Bearer tok-admin' }
beforeEach(() => {
  registro.ops.length = 0; registro.dados = {}; registro.falhas = {}; registro.seq = 0
  registro.auth = { tokens: { 'tok-super': ID_SUPER, 'tok-admin': 'auth-admin' }, chamadas: [], erro: null }
  registro.db = {
    empresas: [{ id: EMP, nome_empresa: 'Loja Integração', status: 'ativo', plano: 'master', created_at: '2026-01-01' }],
    faturas: [],
    users: [
      { id: 'u-admin', auth_id: 'auth-admin', empresa_id: EMP, name: 'Ana', email: 'ana@int.local', role: 'admin', active: true, password: 'x' },
      { id: 'u-func', auth_id: 'auth-func', empresa_id: EMP, name: 'Fábio', email: 'fabio@int.local', role: 'employee', active: false, password: 'x' }
    ]
  }
})
const criar = (email) => chamar(app, 'POST', '/api/conta/usuarios', { headers: ADM, body: { name: 'Novo', email, role: 'employee' } })
const reativar = () => chamar(app, 'PATCH', '/api/conta/usuarios/u-func', { headers: ADM, body: { active: true } })

test('a lista de status SEM ACESSO do 0.4 é a mesma do V4 (não podem divergir)', () => {
  const { STATUS_SEM_ACESSO } = require('../src/superadmin/assinatura')
  const { EMPRESA_SEM_ACESSO } = require('../src/conta/rotas')
  assert.deepEqual([...EMPRESA_SEM_ACESSO].sort(), [...STATUS_SEM_ACESSO].sort())
})

test('Super Admin BLOQUEIA (V4) → o ERP (0.4) não cria nem reativa funcionário; ATIVAR (V4) → volta a permitir', async () => {
  assert.equal((await chamar(app, 'POST', `/api/superadmin/empresas/${EMP}/bloquear`, { headers: SA, body: {} })).status, 200)
  assert.equal((await criar('novo1@int.local')).status, 403)
  assert.equal((await reativar()).status, 403)
  assert.equal(registro.db.users.length, 2, 'nada criado')
  assert.equal((await chamar(app, 'POST', `/api/superadmin/empresas/${EMP}/ativar`, { headers: SA, body: {} })).status, 200)
  assert.equal((await criar('novo2@int.local')).status, 201)
  assert.equal((await reativar()).status, 200)
})

test('Super Admin muda para INATIVO e CANCELADO (V4) → o ERP (0.4) recusa criar funcionário', async () => {
  for (const st of ['inativo', 'cancelado']) {
    registro.db.empresas[0].status = 'ativo'
    assert.equal((await chamar(app, 'PATCH', `/api/superadmin/empresas/${EMP}`, { headers: SA, body: { status: st } })).status, 200)
    assert.equal((await criar(`x-${st}@int.local`)).status, 403, st)
  }
})

test('rotas convivem: sessão de cliente não abre o Super Admin; sessão do Super Admin (fora de users) não abre a conta do ERP', async () => {
  assert.equal((await chamar(app, 'GET', '/api/superadmin/empresas', { headers: ADM })).status, 403)
  const r = await chamar(app, 'GET', '/api/conta/me', { headers: SA })
  assert.ok([401, 403].includes(r.status), String(r.status))
})

test('CORS: /api/superadmin só o painel; /api/conta só ERP e site; o resto continua aberto', async () => {
  const origem = async (caminho, o) => (await chamar(app, 'OPTIONS', caminho, { headers: { origin: o, 'access-control-request-method': 'POST' } })).headers['access-control-allow-origin']
  assert.equal(await origem('/api/superadmin/empresas', 'https://admin.tmp10.com.br'), 'https://admin.tmp10.com.br')
  assert.equal(await origem('/api/superadmin/empresas', 'https://sistema.tmp10.com.br'), undefined)
  assert.equal(await origem('/api/conta/usuarios', 'https://sistema.tmp10.com.br'), 'https://sistema.tmp10.com.br')
  assert.equal(await origem('/api/conta/cadastro', 'https://tmp10.com.br'), 'https://tmp10.com.br')
  assert.equal(await origem('/api/conta/usuarios', 'https://admin.tmp10.com.br'), undefined)
  assert.equal(await origem('/api/conta/usuarios', 'https://site-qualquer.example'), undefined)
  assert.equal(await origem('/api/sync', 'https://site-qualquer.example'), '*')
})
