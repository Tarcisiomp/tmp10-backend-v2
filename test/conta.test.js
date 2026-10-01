// Testes da conta central (Etapa 0, passos 0.3/0.4) — rodar: npm test
// Supabase (banco e Auth) simulados; nada acessa produção.
const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { registro, envTeste, chamar } = require('./helpers')

envTeste()
const app = require('../server')
after(() => setTimeout(() => process.exit(0), 50))

const EMP_A = 'empresa-A'
const EMP_B = 'empresa-B'

beforeEach(() => {
  registro.seq = 0
  registro.ops.length = 0
  registro.falhas = {}
  registro.auth = { tokens: { 'tok-admin-a': 'auth-admin-a', 'tok-oper-a': 'auth-oper-a', 'tok-admin-b': 'auth-admin-b', 'tok-inativo': 'auth-inativo', 'tok-vend-a': 'auth-vend-a', 'tok-sem-cadastro': 'auth-sem-cadastro' }, chamadas: [], erro: null }
  registro.db = {
    empresas: [{ id: EMP_A, nome_empresa: 'Loja A', modulos: null, status: 'ativo' }, { id: EMP_B, nome_empresa: 'Loja B', modulos: null, status: 'ativo' }],
    users: [
      { id: 'u-admin-a', auth_id: 'auth-admin-a', empresa_id: EMP_A, name: 'Ana', email: 'ana@a.com', role: 'admin', active: true, password: 'SENHA-ANTIGA-1' },
      { id: 'u-oper-a', auth_id: 'auth-oper-a', empresa_id: EMP_A, name: 'Otto', email: 'otto@a.com', role: 'employee', active: true, password: 'SENHA-ANTIGA-2' },
      { id: 'u-vend-a', auth_id: 'auth-vend-a', empresa_id: EMP_A, name: 'Vera', email: 'vera@a.com', role: 'admin', is_vendedor_externo: true, active: true, password: 'x' },
      { id: 'u-inativo', auth_id: 'auth-inativo', empresa_id: EMP_A, name: 'Ivo', email: 'ivo@a.com', role: 'admin', active: false, password: 'x' },
      { id: 'u-admin-b', auth_id: 'auth-admin-b', empresa_id: EMP_B, name: 'Bia', email: 'bia@b.com', role: 'admin', active: true, password: 'SENHA-ANTIGA-3' },
      { id: 'u-oper-b', auth_id: 'auth-oper-b', empresa_id: EMP_B, name: 'Beto', email: 'beto@b.com', role: 'employee', active: true, password: 'x' }
    ]
  }
})

const auth = (t) => ({ authorization: `Bearer ${t}` })
const usuario = (id) => registro.db.users.find((u) => u.id === id)

// ── Sessão ───────────────────────────────────────────────────────────
test('sem sessão → 401 (me, criar, editar)', async () => {
  assert.equal((await chamar(app, 'GET', '/api/conta/me')).status, 401)
  assert.equal((await chamar(app, 'POST', '/api/conta/usuarios', { body: { name: 'X', email: 'x@x.com' } })).status, 401)
  assert.equal((await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { body: { name: 'X' } })).status, 401)
})

test('sessão inválida → 401', async () => {
  assert.equal((await chamar(app, 'GET', '/api/conta/me', { headers: auth('token-falso') })).status, 401)
  assert.equal((await chamar(app, 'GET', '/api/conta/me', { headers: { authorization: 'Basic abc' } })).status, 401)
})

test('sessão válida mas sem cadastro no TMP10 → 403', async () => {
  assert.equal((await chamar(app, 'GET', '/api/conta/me', { headers: auth('tok-sem-cadastro') })).status, 403)
})

test('usuário desativado → 403', async () => {
  assert.equal((await chamar(app, 'GET', '/api/conta/me', { headers: auth('tok-inativo') })).status, 403)
})

test('/api/conta/me devolve usuário e empresa da sessão, sem senha', async () => {
  const r = await chamar(app, 'GET', '/api/conta/me', { headers: auth('tok-admin-a') })
  assert.equal(r.status, 200)
  const j = JSON.parse(r.texto)
  assert.equal(j.usuario.id, 'u-admin-a')
  assert.equal(j.empresa.id, EMP_A)
  assert.doesNotMatch(r.texto, /SENHA-ANTIGA|password/)
})

// ── Criar usuário ────────────────────────────────────────────────────
test('admin cria usuário na PRÓPRIA empresa (empresa_id do navegador ignorado)', async () => {
  const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-admin-a'), body: { name: 'Novo', email: 'Novo@A.com', role: 'employee', empresa_id: EMP_B } })
  assert.equal(r.status, 201, r.texto)
  const criado = registro.db.users.find((u) => u.email === 'novo@a.com')
  assert.equal(criado.empresa_id, EMP_A)
  assert.ok(criado.auth_id)
  assert.match(criado.password, /^!supabase-auth:[0-9a-f]{48}$/, 'senha na tabela users deve ser inutilizável')
  assert.equal(JSON.parse(r.texto).convite, true)
  assert.equal(registro.auth.chamadas[0][0], 'invite')
})

test('admin cria usuário com senha inicial → conta criada no Auth, senha NÃO vai para users', async () => {
  const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-admin-a'), body: { name: 'Com Senha', email: 'cs@a.com', password: 'SenhaForte123' } })
  assert.equal(r.status, 201, r.texto)
  const criado = registro.db.users.find((u) => u.email === 'cs@a.com')
  assert.notEqual(criado.password, 'SenhaForte123')
  assert.equal(registro.auth.chamadas[0][0], 'createUser')
})

test('operador NÃO pode criar usuário → 403', async () => {
  const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-oper-a'), body: { name: 'X', email: 'x@a.com' } })
  assert.equal(r.status, 403)
  assert.equal(registro.auth.chamadas.length, 0)
})

test('vendedor externo (mesmo com papel admin) NÃO pode criar usuário → 403', async () => {
  const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-vend-a'), body: { name: 'X', email: 'x@a.com' } })
  assert.equal(r.status, 403)
})

test('e-mail repetido → 409, sem criar conta no Auth', async () => {
  const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-admin-a'), body: { name: 'X', email: 'bia@b.com' } })
  assert.equal(r.status, 409)
  assert.equal(registro.auth.chamadas.length, 0)
})

test('dados inválidos → 400 (nome, e-mail, senha curta, papel desconhecido vira employee)', async () => {
  const h = auth('tok-admin-a')
  assert.equal((await chamar(app, 'POST', '/api/conta/usuarios', { headers: h, body: { email: 'a@a.com' } })).status, 400)
  assert.equal((await chamar(app, 'POST', '/api/conta/usuarios', { headers: h, body: { name: 'X', email: 'nao-e-email' } })).status, 400)
  assert.equal((await chamar(app, 'POST', '/api/conta/usuarios', { headers: h, body: { name: 'X', email: 'x@a.com', password: '123' } })).status, 400)
  const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: h, body: { name: 'X', email: 'x2@a.com', role: 'superadmin' } })
  assert.equal(r.status, 201)
  assert.equal(registro.db.users.find((u) => u.email === 'x2@a.com').role, 'employee')
})

test('se gravar em users falhar, a conta criada no Auth é desfeita', async () => {
  registro.falhas['users.insert'] = { message: 'falha simulada' }
  const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-admin-a'), body: { name: 'X', email: 'x@a.com' } })
  assert.equal(r.status, 500)
  assert.ok(registro.auth.chamadas.some((c) => c[0] === 'delete'))
})

// ── Editar usuário ───────────────────────────────────────────────────
test('empresa A NÃO edita usuário da empresa B → 404 e nada muda', async () => {
  const antes = JSON.stringify(usuario('u-oper-b'))
  const r = await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-b', { headers: auth('tok-admin-a'), body: { name: 'Hackeado', active: false, password: 'NovaSenha123' } })
  assert.equal(r.status, 404)
  assert.equal(JSON.stringify(usuario('u-oper-b')), antes)
  assert.equal(registro.auth.chamadas.length, 0)
})

test('empresa A NÃO cria usuário dentro da empresa B, mesmo mandando empresa_id', async () => {
  await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-admin-a'), body: { name: 'Intruso', email: 'intruso@x.com', empresa_id: EMP_B } })
  assert.equal(registro.db.users.filter((u) => u.empresa_id === EMP_B).length, 2)
})

test('operador NÃO edita usuário → 403', async () => {
  const r = await chamar(app, 'PATCH', '/api/conta/usuarios/u-admin-a', { headers: auth('tok-oper-a'), body: { role: 'employee' } })
  assert.equal(r.status, 403)
  assert.equal(usuario('u-admin-a').role, 'admin')
})

test('admin edita usuário da própria empresa; empresa_id do corpo é ignorado', async () => {
  const r = await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { name: 'Otto Silva', cargo: 'Caixa', empresa_id: EMP_B } })
  assert.equal(r.status, 200, r.texto)
  assert.equal(usuario('u-oper-a').name, 'Otto Silva')
  assert.equal(usuario('u-oper-a').empresa_id, EMP_A)
})

test('desativar = bloqueia login no Auth + active=false; nada é apagado', async () => {
  const r = await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { active: false } })
  assert.equal(r.status, 200)
  assert.equal(usuario('u-oper-a').active, false)
  assert.ok(registro.auth.chamadas.some((c) => c[0] === 'update' && c[2].ban_duration === '876000h'))
  assert.equal(registro.ops.filter((o) => o.acao === 'delete').length, 0)
})

test('reativar = remove o bloqueio no Auth', async () => {
  usuario('u-oper-a').active = false
  await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { active: true } })
  assert.equal(usuario('u-oper-a').active, true)
  assert.ok(registro.auth.chamadas.some((c) => c[0] === 'update' && c[2].ban_duration === 'none'))
})

for (const statusEmpresa of ['bloqueado', 'inativo', 'cancelado']) {
  test(`empresa ${statusEmpresa}: NÃO permite criar funcionário (403, nada criado no Auth nem no banco)`, async () => {
    registro.db.empresas.find((e) => e.id === EMP_A).status = statusEmpresa
    const antes = registro.db.users.length
    const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-admin-a'), body: { name: 'Novo', email: 'novo-bloq@a.com', role: 'employee', password: 'SenhaForte123' } })
    assert.equal(r.status, 403)
    assert.match(r.texto, /suspenso/)
    assert.equal(registro.db.users.length, antes)
    assert.deepEqual(registro.auth.chamadas, [], 'nenhuma conta criada nem convite enviado no Auth')
    assert.ok(!registro.ops.some((o) => o.tabela === 'users' && o.acao === 'insert'))
  })
}
// "Em tolerância" é empresa com status ativo e fatura vencida há até 5 dias: o status continua 'ativo'
for (const [rotulo, statusEmpresa, extra] of [['ativa', 'ativo', {}], ['em trial válido', 'trial', { trial_fim: '2099-12-31' }], ['em tolerância (status ativo, fatura vencida há 3 dias)', 'ativo', {}]]) {
  test(`empresa ${rotulo}: permite criar funcionário normalmente`, async () => {
    Object.assign(registro.db.empresas.find((e) => e.id === EMP_A), { status: statusEmpresa, ...extra })
    if (rotulo.startsWith('em tolerância')) {
      const venc = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
      registro.db.faturas = [{ id: 'fat-tol', empresa_id: EMP_A, status: 'vencido', vencimento: venc, valor_total: 100 }]
    }
    const r = await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-admin-a'), body: { name: 'Novo', email: `novo-${statusEmpresa}@a.com`, role: 'employee' } })
    assert.equal(r.status, 201, r.texto)
    assert.ok(registro.db.users.find((u) => u.email === `novo-${statusEmpresa}@a.com` && u.empresa_id === EMP_A))
  })
}
for (const statusEmpresa of ['bloqueado', 'inativo', 'cancelado']) {
  test(`empresa ${statusEmpresa}: funcionário NÃO pode ser reativado (403, nada muda no Auth nem no banco)`, async () => {
    registro.db.empresas.find((e) => e.id === EMP_A).status = statusEmpresa
    usuario('u-oper-a').active = false
    const r = await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { active: true, name: 'Otto 2' } })
    assert.equal(r.status, 403)
    assert.match(r.texto, /suspenso/)
    assert.equal(usuario('u-oper-a').active, false); assert.equal(usuario('u-oper-a').name, 'Otto')
    assert.deepEqual(registro.auth.chamadas.filter((c) => c[0] === 'update'), [])
  })
}
test('empresa bloqueada: o resto do 0.4 continua igual (desativar e editar nome funcionam; reativar em empresa ativa também)', async () => {
  registro.db.empresas.find((e) => e.id === EMP_A).status = 'bloqueado'
  assert.equal((await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { name: 'Otto 3', active: false } })).status, 200)
  assert.equal(usuario('u-oper-a').active, false)
  registro.db.empresas.find((e) => e.id === EMP_A).status = 'ativo'
  assert.equal((await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { active: true } })).status, 200)
  assert.equal(usuario('u-oper-a').active, true)
})

test('trocar senha vai para o Auth e NÃO para a tabela users', async () => {
  await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { password: 'NovaSenha123' } })
  assert.equal(usuario('u-oper-a').password, 'SENHA-ANTIGA-2')
  assert.ok(registro.auth.chamadas.some((c) => c[0] === 'update' && c[2].password === 'NovaSenha123'))
})

test('admin não desativa nem rebaixa a si mesmo', async () => {
  assert.equal((await chamar(app, 'PATCH', '/api/conta/usuarios/u-admin-a', { headers: auth('tok-admin-a'), body: { active: false } })).status, 400)
  assert.equal((await chamar(app, 'PATCH', '/api/conta/usuarios/u-admin-a', { headers: auth('tok-admin-a'), body: { role: 'employee' } })).status, 400)
  assert.equal(usuario('u-admin-a').active, true)
  assert.equal(usuario('u-admin-a').role, 'admin')
})

test('trocar e-mail para um já usado → 409', async () => {
  const r = await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { email: 'BIA@b.com' } })
  assert.equal(r.status, 409)
  assert.equal(usuario('u-oper-a').email, 'otto@a.com')
})

// ── Não mexe no resto ────────────────────────────────────────────────
test('rotas da conta não gravam em nenhuma tabela além de users', async () => {
  await chamar(app, 'POST', '/api/conta/usuarios', { headers: auth('tok-admin-a'), body: { name: 'X', email: 'x@a.com' } })
  await chamar(app, 'PATCH', '/api/conta/usuarios/u-oper-a', { headers: auth('tok-admin-a'), body: { name: 'Y' } })
  const tabelas = new Set(registro.ops.filter((o) => o.acao !== 'select').map((o) => o.tabela))
  assert.deepEqual([...tabelas], ['users'])
})

// ── Super Admin / rotas administrativas ──────────────────────────────
test('sessão de cliente (mesmo admin da empresa) NÃO abre rotas administrativas da plataforma', async () => {
  for (const [m, c] of [['GET', '/api/orders'], ['GET', '/api/faturamento/status/empresa-A'], ['GET', '/api/faturamento/processar-fechamentos'], ['GET', '/api/stats']]) {
    const r = await chamar(app, m, c, { headers: auth('tok-admin-a') })
    assert.ok([401, 403].includes(r.status), `${m} ${c} → ${r.status}`)
  }
})

// ── CORS ─────────────────────────────────────────────────────────────
test('CORS: /api/conta/* aceita só os endereços oficiais do TMP10', async () => {
  const pre = (origem) => chamar(app, 'OPTIONS', '/api/conta/cadastro', { headers: { origin: origem, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
  for (const ok of ['https://tmp10.com.br', 'https://sistema.tmp10.com.br']) {
    const r = await pre(ok)
    assert.equal(r.headers['access-control-allow-origin'], ok, ok)
  }
  const ruim = await pre('https://site-falso.com')
  assert.equal(ruim.headers['access-control-allow-origin'], undefined)
})

test('CORS: as outras rotas continuam como antes (sem mudança para integrações)', async () => {
  const r = await chamar(app, 'GET', '/', { headers: { origin: 'https://qualquer.com' } })
  assert.equal(r.headers['access-control-allow-origin'], '*')
})

// ── Sessão encerrada ─────────────────────────────────────────────────
test('depois do logout (token revogado no Supabase), /api/conta/* recusa → 401', async () => {
  delete registro.auth.tokens['tok-admin-a']
  assert.equal((await chamar(app, 'GET', '/api/conta/me', { headers: auth('tok-admin-a') })).status, 401)
})
