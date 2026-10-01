// Testes do cadastro público (site tmp10.com.br → backend) — Etapa 0, passo 0.4
const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { registro, envTeste, chamar } = require('./helpers')

envTeste()
const app = require('../server')
after(() => setTimeout(() => process.exit(0), 50))

const OK = { empresa: 'Loja Nova', nome: 'João Silva', email: 'Joao@Loja.com', whatsapp: '(16) 99999-0000', senha: 'SenhaBoa123' }

beforeEach(() => {
  registro.seq = 0
  registro.ops.length = 0
  registro.falhas = {}
  registro.auth = { tokens: {}, chamadas: [], erro: null, falhaLogin: false }
  registro.db = {
    empresas: [{ id: 'emp-existente', nome_empresa: 'Antiga' }],
    users: [
      { id: 'u-velho', empresa_id: 'emp-existente', username: 'antigo@loja.com', email: null, role: 'admin', active: true, password: 'x' },
      { id: 'u-novo', empresa_id: 'emp-existente', username: 'maria@loja.com', email: 'maria@loja.com', role: 'employee', active: true, password: 'y' }
    ]
  }
})

test('cadastro cria empresa (trial 7 dias) + usuário admin ligado ao Supabase Auth, sem senha no banco', async () => {
  const r = await chamar(app, 'POST', '/api/conta/cadastro', { body: OK })
  assert.equal(r.status, 201, r.texto)
  const emp = registro.db.empresas.find((e) => e.nome_empresa === 'Loja Nova')
  assert.ok(emp)
  assert.equal(emp.status, 'trial')
  assert.equal(emp.plano, 'trial')
  assert.equal(emp.email, 'joao@loja.com')
  const esperado = new Date(); esperado.setDate(esperado.getDate() + 7)
  assert.equal(emp.trial_fim, esperado.toISOString().slice(0, 10))
  assert.ok(!('modulos' in emp), 'não mexe em modulos (mesmo comportamento do site hoje)')
  const u = registro.db.users.find((x) => x.email === 'joao@loja.com')
  assert.equal(u.empresa_id, emp.id)
  assert.equal(u.role, 'admin')
  assert.equal(u.username, 'joao@loja.com')
  assert.ok(u.auth_id)
  assert.notEqual(u.password, OK.senha)
  assert.match(u.password, /^!supabase-auth:/)
  assert.deepEqual(registro.auth.chamadas[0], ['createUser', { email: 'joao@loja.com', password: 'SenhaBoa123', email_confirm: true }])
})

test('cadastro devolve a sessão para o cliente entrar direto no ERP', async () => {
  const r = await chamar(app, 'POST', '/api/conta/cadastro', { body: OK })
  const j = JSON.parse(r.texto)
  assert.equal(j.sessao.access_token, 'at-joao@loja.com')
  assert.equal(j.sessao.token_type, 'bearer')
})

test('se abrir a sessão falhar, a conta continua criada e o site manda para o login', async () => {
  registro.auth.falhaLogin = true
  const r = await chamar(app, 'POST', '/api/conta/cadastro', { body: OK })
  assert.equal(r.status, 201)
  assert.equal(JSON.parse(r.texto).sessao, null)
})

test('e-mail já usado (conta nova OU conta antiga do site) → 409, nada é criado', async () => {
  for (const email of ['maria@loja.com', 'ANTIGO@loja.com']) {
    const r = await chamar(app, 'POST', '/api/conta/cadastro', { body: { ...OK, email } })
    assert.equal(r.status, 409, email)
  }
  assert.equal(registro.db.empresas.length, 1)
  assert.equal(registro.auth.chamadas.length, 0)
})

test('campos inválidos → 400 (vazio, e-mail, whatsapp, senha curta)', async () => {
  const casos = [{ empresa: '' }, { email: 'x' }, { whatsapp: '123' }, { senha: '1234567' }]
  for (const c of casos) {
    const r = await chamar(app, 'POST', '/api/conta/cadastro', { body: { ...OK, ...c } })
    assert.equal(r.status, 400, JSON.stringify(c))
  }
  assert.equal(registro.auth.chamadas.length, 0)
})

test('campos extras do navegador são ignorados (papel, empresa, módulos, ativo)', async () => {
  await chamar(app, 'POST', '/api/conta/cadastro', { body: { ...OK, empresa_id: 'emp-existente', role: 'superadmin', modulos: ['tudo'], status: 'ativo', plano: 'master' } })
  const u = registro.db.users.find((x) => x.email === 'joao@loja.com')
  assert.notEqual(u.empresa_id, 'emp-existente')
  assert.equal(u.role, 'admin')
  const emp = registro.db.empresas.find((e) => e.id === u.empresa_id)
  assert.equal(emp.status, 'trial')
  assert.equal(emp.plano, 'trial')
  assert.ok(!('modulos' in emp))
})

test('falha ao gravar o usuário → desfaz só a empresa e o login criados agora', async () => {
  registro.falhas['users.insert'] = { message: 'falha simulada' }
  const r = await chamar(app, 'POST', '/api/conta/cadastro', { body: OK })
  assert.equal(r.status, 500)
  assert.deepEqual(registro.db.empresas.map((e) => e.id), ['emp-existente'], 'a empresa antiga continua; a nova foi desfeita')
  assert.ok(registro.auth.chamadas.some((c) => c[0] === 'delete'))
  const apagou = registro.ops.filter((o) => o.acao === 'delete')
  assert.equal(apagou.length, 1)
  assert.equal(apagou[0].tabela, 'empresas')
  assert.notDeepEqual(apagou[0].filtros[0], ['eq', 'id', 'emp-existente'])
})

test('falha ao criar a empresa → desfaz o login criado agora', async () => {
  registro.falhas['empresas.insert'] = { message: 'falha simulada' }
  const r = await chamar(app, 'POST', '/api/conta/cadastro', { body: OK })
  assert.equal(r.status, 500)
  assert.ok(registro.auth.chamadas.some((c) => c[0] === 'delete'))
  assert.equal(registro.db.users.length, 2)
})

test('limite de tentativas por IP → 429', () => {
  const { criarLimitador } = require('../src/conta/cadastro')
  let t = 0
  const lim = criarLimitador({ maxPorJanela: 2, janelaMs: 1000, agora: () => t })
  const req = { headers: {}, ip: '1.2.3.4' }
  const res = { status(c) { this.c = c; return this }, json() { return this } }
  let passou = 0
  const next = () => { passou++ }
  lim(req, res, next); lim(req, res, next); lim(req, res, next)
  assert.equal(passou, 2)
  assert.equal(res.c, 429)
  t = 2000
  lim(req, res, next)
  assert.equal(passou, 3, 'depois da janela, libera de novo')
})
