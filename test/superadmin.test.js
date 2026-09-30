// Super Admin da plataforma (/api/superadmin/*) — Supabase (banco e Auth) simulados; nada acessa produção.
const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { registro, envTeste, chamar, TOKEN_ADMIN } = require('./helpers')

const ID_SUPER = '5a5a5a5a-0000-4000-8000-000000000001'
const ID_SUPER_LIGADO = '5a5a5a5a-0000-4000-8000-000000000002' // está na lista, mas também é usuário de empresa
envTeste({ SUPERADMIN_AUTH_IDS: ` ${ID_SUPER} , nao-e-uuid, ${ID_SUPER_LIGADO}` })
const app = require('../server')
after(() => setTimeout(() => process.exit(0), 50))

const EMP_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const EMP_B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const FAT_1 = 'f0000000-0000-4000-8000-000000000001'
const FAT_2 = 'f0000000-0000-4000-8000-000000000002'
const FAT_3 = 'f0000000-0000-4000-8000-000000000003'
const h = (t) => ({ authorization: `Bearer ${t}` })
const respostas = [] // todo texto de resposta, para o teste de segredos
async function req(metodo, caminho, opcoes = {}) {
  const r = await chamar(app, metodo, caminho, opcoes)
  respostas.push(r.texto)
  let json = null; try { json = JSON.parse(r.texto) } catch (_) {}
  return { ...r, json }
}

beforeEach(() => {
  registro.ops.length = 0
  registro.dados = {}
  registro.auth = { tokens: { 'tok-super': ID_SUPER, 'tok-super-ligado': ID_SUPER_LIGADO, 'tok-cliente': 'auth-cliente-a' }, chamadas: [], erro: null }
  registro.db = {
    empresas: [
      { id: EMP_A, nome_empresa: 'Loja A', email: 'a@a.com', status: 'ativo', plano: 'master', modulos: ['mercadolivre'], created_at: '2026-09-01T00:00:00Z', caixa_saldo_inicial: 10, trial_fim: '2026-09-10', dia_vencimento_fatura: null, ultimo_fechamento: null },
      { id: EMP_B, nome_empresa: 'Loja B', email: 'b@b.com', status: 'trial', plano: '', modulos: [], created_at: '2026-09-02T00:00:00Z' }
    ],
    users: [
      { id: 'u-cliente', auth_id: 'auth-cliente-a', empresa_id: EMP_A, name: 'Cliente', role: 'admin', active: true, is_vendedor_externo: false },
      { id: 'u-ligado', auth_id: ID_SUPER_LIGADO, empresa_id: EMP_A, name: 'Ligado', role: 'admin', active: true, is_vendedor_externo: false }
    ],
    faturas: [
      { id: FAT_1, empresa_id: EMP_A, status: 'em_aberto', vencimento: '2020-01-10', valor_total: 99.9 },
      { id: FAT_2, empresa_id: EMP_A, status: 'enviada', vencimento: '2999-01-10', valor_total: 150 },
      { id: FAT_3, empresa_id: EMP_B, status: 'pago', vencimento: '2020-01-10', valor_total: 80, valor_pago: 80 }
    ],
    landing_config: [{ chave: 'whatsapp_numero', valor: '5516000000000' }, { chave: 'outra_config', valor: 'nao mexer' }],
    ml_orders: [
      { id: 'o1', empresa_id: EMP_A, status: 'finalizado', created_at_ml: '2026-09-15T10:00:00Z' },
      { id: 'o2', empresa_id: EMP_A, status: 'cancelado', created_at_ml: '2026-09-16T10:00:00Z' },
      { id: 'o3', empresa_id: EMP_B, status: 'finalizado', created_at_ml: '2026-09-16T10:00:00Z' }
    ]
  }
})

const ROTAS = [['GET', '/api/superadmin/sessao'], ['GET', '/api/superadmin/empresas'], ['POST', '/api/superadmin/empresas'],
  ['PATCH', `/api/superadmin/empresas/${EMP_A}`], ['GET', '/api/superadmin/faturas'], ['PATCH', `/api/superadmin/faturas/${FAT_1}`],
  ['GET', '/api/superadmin/config'], ['PATCH', '/api/superadmin/config'], ['GET', `/api/superadmin/ciclo/${EMP_A}`]]

test('T5 — sem token ou token inválido → 401 em todas as rotas', async () => {
  for (const [m, c] of ROTAS) {
    assert.equal((await req(m, c, { body: m === 'GET' ? undefined : {} })).status, 401, `${m} ${c}`)
    assert.equal((await req(m, c, { headers: h('token-falso'), body: m === 'GET' ? undefined : {} })).status, 401, `${m} ${c} token falso`)
  }
})

test('T6/T10 — cliente logado (admin de empresa) → 403 em todas as rotas; nada muda', async () => {
  for (const [m, c] of ROTAS) {
    const r = await req(m, c, { headers: h('tok-cliente'), body: m === 'GET' ? undefined : { status: 'bloqueado', nome_empresa: 'X', email: 'x@x.com' } })
    assert.equal(r.status, 403, `${m} ${c}`)
    assert.ok(!r.texto.includes('Loja A') && !r.texto.includes('Loja B'), 'não devolve dados')
  }
  assert.equal(registro.db.empresas.length, 2)
  assert.equal(registro.db.empresas[0].status, 'ativo')
})

test('separação: conta da lista que também é usuário de empresa (public.users) → 403', async () => {
  assert.equal((await req('GET', '/api/superadmin/empresas', { headers: h('tok-super-ligado') })).status, 403)
})

test('SUPERADMIN_AUTH_IDS: aceita vários ids, ignora valores inválidos; vazia → ninguém entra', () => {
  const { lerIdsSuperAdmin, criarExigirSuperAdmin } = require('../src/superadmin/auth')
  const logs = []
  const ids = lerIdsSuperAdmin(`${ID_SUPER}, xyz ,,${ID_SUPER_LIGADO.toUpperCase()}`, (m) => logs.push(m))
  assert.deepEqual([...ids], [ID_SUPER, ID_SUPER_LIGADO])
  assert.equal(logs.length, 1)
  const logsVazio = []
  criarExigirSuperAdmin({ sb: {}, ids: '', log: (m) => logsVazio.push(m) })
  assert.match(logsVazio[0], /vazia/)
})

test('T7 — Super Admin lista todas as empresas', async () => {
  const r = await req('GET', '/api/superadmin/empresas', { headers: h('tok-super') })
  assert.equal(r.status, 200)
  assert.equal(r.json.empresas.length, 2)
  assert.deepEqual(r.json.empresas.map((e) => e.nome_empresa).sort(), ['Loja A', 'Loja B'])
  const s = await req('GET', '/api/superadmin/sessao', { headers: h('tok-super') })
  assert.equal(s.status, 200)
})

test('T8 — Super Admin cria empresa (só campos permitidos; status padrão trial)', async () => {
  const r = await req('POST', '/api/superadmin/empresas', { headers: h('tok-super'), body: { nome_empresa: 'Loja Nova', email: 'Nova@Loja.com', plano: 'basico', modulos: ['shopee', 'estoque'], dia_vencimento_fatura: 10, trial_inicio: '2026-09-29', trial_fim: '2026-10-06' } })
  assert.equal(r.status, 201, r.texto)
  const nova = registro.db.empresas.find((e) => e.nome_empresa === 'Loja Nova')
  assert.equal(nova.email, 'nova@loja.com'); assert.equal(nova.status, 'trial'); assert.deepEqual(nova.modulos, ['shopee', 'estoque'])
  assert.equal((await req('POST', '/api/superadmin/empresas', { headers: h('tok-super'), body: { email: 'x@x.com' } })).status, 400, 'sem nome')
  assert.equal((await req('POST', '/api/superadmin/empresas', { headers: h('tok-super'), body: { nome_empresa: 'X', email: 'x@x.com', id: EMP_A } })).status, 400, 'id proibido')
  assert.equal((await req('POST', '/api/superadmin/empresas', { headers: h('tok-super'), body: { nome_empresa: 'X', email: 'x@x.com', modulos: ['modulo_inventado'] } })).status, 400)
})

test('T9 — Super Admin edita, ativa, bloqueia e confirma pagamento (status)', async () => {
  const r = await req('PATCH', `/api/superadmin/empresas/${EMP_B}`, { headers: h('tok-super'), body: { nome_empresa: 'Loja B2', plano: 'enterprise', status: 'ativo', modulos: ['financeiro'], trial_fim: null, dia_vencimento_fatura: 5 } })
  assert.equal(r.status, 200, r.texto)
  const b = registro.db.empresas.find((e) => e.id === EMP_B)
  assert.equal(b.nome_empresa, 'Loja B2'); assert.equal(b.status, 'ativo'); assert.equal(b.plano, 'enterprise'); assert.equal(b.trial_fim, null)
  for (const st of ['inativo', 'ativo']) {
    assert.equal((await req('PATCH', `/api/superadmin/empresas/${EMP_A}`, { headers: h('tok-super'), body: { status: st } })).status, 200)
    assert.equal(registro.db.empresas.find((e) => e.id === EMP_A).status, st)
  }
  assert.equal((await req('PATCH', `/api/superadmin/empresas/${EMP_A}`, { headers: h('tok-super'), body: { status: 'status-inventado' } })).status, 400)
  assert.equal((await req('PATCH', '/api/superadmin/empresas/cccccccc-0000-4000-8000-00000000000c', { headers: h('tok-super'), body: { status: 'ativo' } })).status, 404)
})

test('T14 — campos proibidos no PATCH são recusados e NADA é alterado', async () => {
  const antes = JSON.stringify(registro.db.empresas.find((e) => e.id === EMP_A))
  for (const corpo of [{ id: EMP_B }, { created_at: '2000-01-01' }, { caixa_saldo_inicial: 999 }, { empresa_id: EMP_B }, { status: 'ativo', ultimo_fechamento: '2000-01-01' }]) {
    const r = await req('PATCH', `/api/superadmin/empresas/${EMP_A}`, { headers: h('tok-super'), body: corpo })
    assert.equal(r.status, 400, JSON.stringify(corpo))
    assert.match(r.json.error, /não permitido/)
  }
  assert.equal(JSON.stringify(registro.db.empresas.find((e) => e.id === EMP_A)), antes)
})

test('T11 — faturas: lista, marca vencidas no servidor, enviada, paga (com validação)', async () => {
  const r = await req('GET', '/api/superadmin/faturas', { headers: h('tok-super') })
  assert.equal(r.status, 200)
  assert.equal(r.json.faturas.length, 3); assert.equal(r.json.empresas.length, 2)
  assert.equal(registro.db.faturas.find((f) => f.id === FAT_1).status, 'vencido', 'vencida e não paga → vencido')
  assert.equal(registro.db.faturas.find((f) => f.id === FAT_2).status, 'enviada', 'no prazo → não muda')
  assert.equal(registro.db.faturas.find((f) => f.id === FAT_3).status, 'pago', 'paga → não muda')
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${FAT_2}`, { headers: h('tok-super'), body: { acao: 'enviada' } })).status, 200)
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${FAT_2}`, { headers: h('tok-super'), body: { acao: 'pago', valor_pago: 'abc', forma_pagamento: 'Cheque' } })).status, 400, 'forma inválida')
  const p = await req('PATCH', `/api/superadmin/faturas/${FAT_2}`, { headers: h('tok-super'), body: { acao: 'pago', valor_pago: '', forma_pagamento: 'Pix', status: 'qualquer', confirmado_por: 'hacker' } })
  assert.equal(p.status, 200)
  const f2 = registro.db.faturas.find((f) => f.id === FAT_2)
  assert.equal(f2.status, 'pago'); assert.equal(f2.valor_pago, 150, 'sem valor → total da fatura'); assert.equal(f2.forma_pagamento, 'Pix'); assert.equal(f2.confirmado_por, 'admin')
  assert.match(f2.data_pagamento, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${FAT_2}`, { headers: h('tok-super'), body: { acao: 'pago', forma_pagamento: 'Pix' } })).status, 409, 'não paga duas vezes')
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${FAT_3}`, { headers: h('tok-super'), body: { acao: 'enviada' } })).status, 409, 'paga não volta para enviada')
  assert.equal((await req('PATCH', `/api/superadmin/faturas/${FAT_1}`, { headers: h('tok-super'), body: { acao: 'apagar' } })).status, 400)
})

test('T12 — WhatsApp e Pix: lê, salva, cria a linha que falta; outras chaves bloqueadas', async () => {
  const g = await req('GET', '/api/superadmin/config', { headers: h('tok-super') })
  assert.equal(g.status, 200)
  assert.equal(g.json.config.whatsapp_numero, '5516000000000'); assert.equal(g.json.config.pix_chave, '')
  assert.ok(!('outra_config' in g.json.config), 'não expõe outras chaves')
  const p = await req('PATCH', '/api/superadmin/config', { headers: h('tok-super'), body: { whatsapp_numero: '(55) 16 99161-9677', pix_chave: 'chave@pix.com', pix_beneficiario: 'TMP' } })
  assert.equal(p.status, 200, p.texto)
  const cfg = Object.fromEntries(registro.db.landing_config.map((l) => [l.chave, l.valor]))
  assert.equal(cfg.whatsapp_numero, '5516991619677'); assert.equal(cfg.pix_chave, 'chave@pix.com'); assert.equal(cfg.pix_beneficiario, 'TMP')
  assert.equal((await req('PATCH', '/api/superadmin/config', { headers: h('tok-super'), body: { outra_config: 'x' } })).status, 400)
  assert.equal((await req('PATCH', '/api/superadmin/config', { headers: h('tok-super'), body: { whatsapp_numero: '123' } })).status, 400)
  assert.equal(registro.db.landing_config.find((l) => l.chave === 'outra_config').valor, 'nao mexer')
})

test('T13 — ciclo atual pela rota do Super Admin (sem token de admin no navegador); rota antiga continua exigindo o token', async () => {
  const r = await req('GET', `/api/superadmin/ciclo/${EMP_A}`, { headers: h('tok-super') })
  assert.equal(r.status, 200, r.texto)
  assert.equal(r.json.ok, true); assert.equal(r.json.cicloDefinido, true); assert.equal(r.json.periodoInicio, '2026-09-10')
  assert.equal(r.json.pedidosNoPeriodo, 1, 'conta só pedidos da empresa, sem cancelados')
  assert.equal((await req('GET', `/api/superadmin/ciclo/${EMP_B}`, { headers: h('tok-super') })).json.cicloDefinido, false)
  assert.equal((await req('GET', '/api/superadmin/ciclo/nao-existe', { headers: h('tok-super') })).status, 404)
  assert.equal((await req('GET', `/api/faturamento/status/${EMP_A}`)).status, 401, 'rota de manutenção continua protegida')
  assert.equal((await req('GET', `/api/faturamento/status/${EMP_A}`, { headers: { 'x-admin-token': TOKEN_ADMIN } })).status, 200)
})

test('CORS: /api/superadmin/* só aceita o endereço do painel', async () => {
  const ok = await req('OPTIONS', '/api/superadmin/empresas', { headers: { origin: 'https://admin.tmp10.com.br', 'access-control-request-method': 'GET' } })
  assert.equal(ok.headers['access-control-allow-origin'], 'https://admin.tmp10.com.br')
  const erp = await req('OPTIONS', '/api/superadmin/empresas', { headers: { origin: 'https://sistema.tmp10.com.br', 'access-control-request-method': 'GET' } })
  assert.equal(erp.headers['access-control-allow-origin'], undefined)
})

test('T16 — nenhuma resposta da API contém chave secreta', () => {
  const tudo = respostas.join('\n')
  for (const segredo of [process.env.SUPABASE_SERVICE_KEY, process.env.ADMIN_API_TOKEN, process.env.ML_CLIENT_SECRET, process.env.VAPID_PRIVATE_KEY, 'sb_secret_', 'service_role']) {
    assert.ok(!tudo.includes(segredo), `resposta contém ${segredo === process.env.SUPABASE_SERVICE_KEY ? 'SUPABASE_SERVICE_KEY' : 'segredo'}`)
  }
  assert.ok(respostas.length > 40)
})
