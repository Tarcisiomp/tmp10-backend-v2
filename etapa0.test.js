// Testes da Etapa 0 — passo 0.1 (segredos fora do código + rotas admin fechadas + empresa nas perguntas)
// Rodar:  npm test
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const { registro, envTeste, chamar, TOKEN_ADMIN } = require('./helpers')

const RAIZ = path.join(__dirname, '..')
const SERVER = fs.readFileSync(path.join(RAIZ, 'server.js'), 'utf-8')

// Rotas que o ERP (index.html) NÃO usa → agora exigem X-Admin-Token
const ROTAS_ADMIN = [
  ['GET', '/api/faturamento/medir-armazenamento/emp-1'],
  ['GET', '/api/faturamento/medir-todas'],
  ['GET', '/api/faturamento/processar-fechamentos'],
  ['GET', '/api/faturamento/gerar-fatura/emp-1'],
  ['GET', '/api/faturamento/status/emp-1'],
  ['GET', '/api/faturamento/verificar-fatura/emp-1'],
  ['POST', '/api/fin/gerar-recorrencias'],
  ['POST', '/api/fin/gerar-faturas'],
  ['POST', '/api/fin/alertar-vencimento'],
  ['POST', '/api/recalcular-todo-historico'],
  ['GET', '/api/recalcular-todo-historico/status'],
  ['GET', '/api/recalcular-um/123'],
  ['POST', '/api/recalcular-um/123'],
  ['POST', '/api/reclassify'],
  ['POST', '/api/backfill-tracking'],
  ['GET', '/api/backfill-tracking/status'],
  ['GET', '/api/ml/accounts?empresa_id=emp-1'],
  ['GET', '/api/orders'],
  ['PATCH', '/api/orders/abc'],
  ['GET', '/api/stats']
]

// Rotas que continuam abertas: raiz, push (protegido pelo pushSeguro) e o aviso do próprio Mercado Livre.
// As rotas de Mercado Livre / Shopee usadas pelo ERP passaram a exigir sessão na Fase 2 (test/fase2-seguranca.test.js).
const ROTAS_ABERTAS = [
  ['GET', '/'],
  ['POST', '/api/push/subscribe'], ['POST', '/api/push/unsubscribe'],
  ['POST', '/api/push/notificar-venda'], ['POST', '/api/push/notificar-mensagem'],
  ['GET', '/api/push/chave-publica'],
  ['POST', '/ml/notifications']
]

envTeste()
const app = require('../server')

after(() => setTimeout(() => process.exit(0), 50))

// ── 1. Segredos ─────────────────────────────────────────────────────
test('nenhum segredo escrito no código', () => {
  const arquivos = ['server.js', 'src/config.js', 'src/adminAuth.js', '.env.example']
  for (const a of arquivos) {
    const txt = fs.readFileSync(path.join(RAIZ, a), 'utf-8')
    assert.doesNotMatch(txt, /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}/, `${a}: parece conter um JWT`)
    for (const nome of ['SUPABASE_SERVICE_KEY', 'ML_CLIENT_SECRET', 'VAPID_PRIVATE_KEY', 'VAPID_PUBLIC_KEY', 'ADMIN_API_TOKEN']) {
      assert.doesNotMatch(txt, new RegExp(`process\\.env\\.${nome}\\s*\\|\\|\\s*['"]`), `${a}: ${nome} com valor reserva no código`)
    }
  }
  const envEx = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf-8')
  for (const linha of envEx.split('\n')) {
    const m = linha.match(/^(SUPABASE_SERVICE_KEY|ML_CLIENT_SECRET|VAPID_PRIVATE_KEY|ADMIN_API_TOKEN)=(.*)$/)
    if (m) assert.equal(m[2].trim(), '', `.env.example não pode ter valor em ${m[1]}`)
  }
})

test('.env nunca vai para o Git', () => {
  const gi = fs.readFileSync(path.join(RAIZ, '.gitignore'), 'utf-8')
  assert.match(gi, /^\.env$/m)
})

test('servidor NÃO inicia sem as variáveis obrigatórias (e não imprime valores)', () => {
  const env = { PATH: process.env.PATH, VAPID_PUBLIC_KEY: 'valor-que-nao-pode-aparecer' }
  const r = spawnSync(process.execPath, ['server.js'], { cwd: RAIZ, env, encoding: 'utf-8', timeout: 20000 })
  assert.equal(r.status, 1, 'deveria sair com código 1')
  for (const nome of ['SUPABASE_SERVICE_KEY', 'ML_CLIENT_SECRET', 'VAPID_PRIVATE_KEY', 'ADMIN_API_TOKEN']) {
    assert.match(r.stderr, new RegExp(nome), `mensagem deveria citar ${nome}`)
  }
  assert.doesNotMatch(r.stderr + r.stdout, /valor-que-nao-pode-aparecer/)
})

test('config: ADMIN_API_TOKEN curto é recusado', () => {
  const { lerConfig } = require('../src/config')
  assert.throws(() => lerConfig({ SUPABASE_SERVICE_KEY: 'x', ML_CLIENT_SECRET: 'x', VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'x', ADMIN_API_TOKEN: 'curto' }), /32 caracteres/)
})

test('config: modo inválido é recusado', () => {
  const { lerConfig } = require('../src/config')
  assert.throws(() => lerConfig({ SUPABASE_SERVICE_KEY: 'x', ML_CLIENT_SECRET: 'x', VAPID_PUBLIC_KEY: 'x', VAPID_PRIVATE_KEY: 'x', ADMIN_API_TOKEN: TOKEN_ADMIN, ADMIN_ROUTES_MODE: 'desligado' }), /enforce/)
})

// ── 2. Inventário de rotas (nenhuma rota esquecida) ─────────────────
test('as 48 rotas continuam registradas e todas estão classificadas', () => {
  const regs = [...SERVER.matchAll(/app\.(get|post|put|patch|delete|all)\('([^']+)'/g)]
  // 44 + 2 do push definitivo: GET /api/push/chave-publica (aberta: chave PÚBLICA) e POST /api/push/testar (exige sessão)
  // + 2 da Fase 2: POST /api/ml/auth-link e POST /api/shopee/auth-link (exigem sessão de administrador)
  assert.equal(regs.length, 48, 'número de rotas mudou — revisar a classificação')
  const comAdmin = [...SERVER.matchAll(/app\.(get|post|put|patch|delete|all)\('([^']+)', exigirAdmin,/g)]
  assert.equal(comAdmin.length, ROTAS_ADMIN.length, 'quantidade de rotas protegidas')
})

// ── 3. Rotas admin ──────────────────────────────────────────────────
for (const [metodo, caminho] of ROTAS_ADMIN) {
  test(`admin ${metodo} ${caminho}: sem token → 401`, async () => {
    const r = await chamar(app, metodo, caminho)
    assert.equal(r.status, 401)
    assert.doesNotMatch(r.texto, /ml_order|access_token|password/i)
  })
  test(`admin ${metodo} ${caminho}: token errado → 403`, async () => {
    const r = await chamar(app, metodo, caminho, { headers: { 'x-admin-token': 'errado-errado-errado-errado-errado-errado' } })
    assert.equal(r.status, 403)
  })
  test(`admin ${metodo} ${caminho}: token certo → executa`, async () => {
    const r = await chamar(app, metodo, caminho, { headers: { 'x-admin-token': TOKEN_ADMIN }, body: metodo === 'PATCH' ? { status: 'separando' } : undefined })
    assert.ok(![401, 403].includes(r.status), `status ${r.status}`)
  })
}

test('token não é aceito pela URL (só pelo cabeçalho)', async () => {
  const r = await chamar(app, 'GET', `/api/orders?x-admin-token=${TOKEN_ADMIN}`)
  assert.equal(r.status, 401)
})

test('PATCH /api/orders sem token não grava nada', async () => {
  registro.ops.length = 0
  const r = await chamar(app, 'PATCH', '/api/orders/abc', { body: { empresa_id: 'outra', status: 'finalizado' } })
  assert.equal(r.status, 401)
  assert.equal(registro.ops.filter((o) => o.tabela === 'ml_orders').length, 0)
})

// ── 4. Rotas usadas pelo ERP continuam iguais ───────────────────────
for (const [metodo, caminho] of ROTAS_ABERTAS) {
  test(`ERP ${metodo} ${caminho}: continua acessível (sem 401/403)`, async () => {
    const r = await chamar(app, metodo, caminho, { body: metodo === 'POST' ? {} : undefined })
    assert.ok(![401, 403].includes(r.status), `status ${r.status}`)
  })
}

// ── 5. Modo report ──────────────────────────────────────────────────
test('modo report: deixa passar e registra no log', () => {
  const { criarExigirAdmin } = require('../src/adminAuth')
  const logs = []
  const mw = criarExigirAdmin({ token: TOKEN_ADMIN, modo: 'report', log: (m) => logs.push(m) })
  let passou = false
  mw({ get: () => undefined, method: 'GET', path: '/api/orders' }, {}, () => { passou = true })
  assert.equal(passou, true)
  assert.match(logs[0], /report.*\/api\/orders.*BLOQUEADA no modo enforce/)
})

// ── 6. Rotinas automáticas continuam registradas ────────────────────
test('as 12 rotinas automáticas (cron) continuam registradas + 1 do Super Admin + 2 do Estoque Central (conferência Shopee e fila)', () => {
  assert.equal(registro.crons, 15)
})

// ── 7. Perguntas passam a gravar a empresa ──────────────────────────
test('syncPerguntas grava empresa_id da conta', async () => {
  registro.ops.length = 0
  registro.dados.ml_accounts = [{ nickname: 'LOJA1', ml_user_id: '999', empresa_id: 'emp-1', access_token: 't', active: true, platform: 'mercadolivre' }]
  registro.axiosGet = (url) => {
    if (url.includes('/questions/search')) return Promise.resolve({ data: { questions: [{ id: 55, item_id: 'MLB1', text: 'tem azul?', from: { nickname: 'comprador' }, date_created: '2026-09-01T10:00:00Z' }] } })
    if (url.includes('/items/')) return Promise.resolve({ data: { title: 'Produto' } })
    return Promise.reject(new Error('não usado'))
  }
  try {
    const r = await chamar(app, 'POST', '/api/sync-perguntas', { headers: { 'x-admin-token': TOKEN_ADMIN }, body: {} })
    assert.equal(r.status, 200)
    let op
    for (let i = 0; i < 40 && !op; i++) {
      await new Promise((ok) => setTimeout(ok, 50))
      op = registro.ops.find((o) => o.tabela === 'ml_perguntas' && o.acao === 'upsert')
    }
    assert.ok(op, 'a pergunta deveria ter sido gravada')
    assert.equal(op.payload.empresa_id, 'emp-1')
    assert.equal(op.payload.pergunta_id, '55')
  } finally {
    registro.dados.ml_accounts = []
    registro.axiosGet = null
  }
})
