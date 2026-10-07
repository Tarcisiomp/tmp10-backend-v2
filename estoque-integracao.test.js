// Estoque Central — integração no server.js (banco e APIs simulados): venda baixa pelo serviço oficial com
// referência do pedido, webhook do ML não usa conta de outra empresa, cancelamento devolve pelo serviço,
// importação não sobrescreve estoque, /api/sync-estoque confere só a empresa da sessão.
const { test, beforeEach, after } = require('node:test')
const assert = require('node:assert/strict')
const { registro, envTeste, chamar, TOKEN_ADMIN } = require('./helpers')
envTeste({ PUSH_EXIGIR_SESSAO: '1', ESTOQUE_ENVIO_HABILITADO: '0' })
const app = require('../server')
after(() => setTimeout(() => process.exit(0), 50))

const A = 'emp-a', B = 'emp-b'
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
beforeEach(() => {
  registro.rpcs = []; registro.ops = []; registro.axiosGet = null; registro.axiosPost = null; registro.axiosPut = null
  registro.auth = { tokens: { 'tok-a': 'auth-a' }, chamadas: [], erro: null }
  registro.rpc = { estoque_movimentar: (a) => ({ data: { ok: true, aplicado: true, duplicado: false, anterior: 10, novo: 10 - a.p_quantidade, movimento_id: 'm1' }, error: null }) }
  registro.db = {
    empresas: [{ id: A, status: 'ativo' }, { id: B, status: 'ativo' }],
    users: [{ id: 'u-a', auth_id: 'auth-a', empresa_id: A, role: 'admin', active: true }],
    ml_accounts: [
      { id: 'acc-a', nickname: 'CONTA1', ml_user_id: '111', platform: null, active: true, empresa_id: A, access_token: 'tok-111' },
      { id: 'acc-b', nickname: 'CONTAB', ml_user_id: '999', platform: null, active: true, empresa_id: B, access_token: 'tok-999' }
    ],
    ml_orders: [{ id: 'o1', ml_order_id: '5001', empresa_id: A, status: 'aguardando', items: [{ sku: 'RALO', qty: 2 }] }],
    estoque_movimentos: [{ id: 'mv1', empresa_id: A, referencia: 'venda:mercadolivre:5001:RALO', quantidade: -2, aplicado: true }],
    products: [{ id: 'p1', empresa_id: A, sku: 'EXISTE', estoque_atual: 42, name: 'antigo' }],
    product_ml_links: [], product_shopee_links: [], estoque_sync_fila: [], estoque_sync_config: [], estoque_divergencias: []
  }
})

test('webhook ML de um user_id desconhecido é IGNORADO (antes caía na conta [0], que podia ser de outra empresa)', async () => {
  const urls = []
  registro.axiosGet = async (url) => { urls.push(url); return { data: { status: 'cancelled' } } }
  await chamar(app, 'POST', '/ml/notifications', { body: { topic: 'orders_v2', resource: '/orders/5001', user_id: 123456 } })
  await espera(80)
  assert.deepEqual(urls, [], 'nenhuma chamada ao ML com token de outra conta')
  assert.equal(registro.db.ml_orders[0].status, 'aguardando')
})

test('webhook ML de cancelamento (conta certa): marca cancelado e devolve o estoque pelo serviço, com referência do pedido', async () => {
  const usados = []
  registro.axiosGet = async (url, op) => { usados.push(op.headers.Authorization); return { data: { status: 'cancelled' } } }
  await chamar(app, 'POST', '/ml/notifications', { body: { topic: 'orders_v2', resource: '/orders/5001', user_id: 111 } })
  await espera(120)
  assert.deepEqual(usados, ['Bearer tok-111'])
  assert.equal(registro.db.ml_orders[0].status, 'cancelado')
  const mov = registro.rpcs.filter(([n]) => n === 'estoque_movimentar')
  assert.equal(mov.length, 1)
  assert.deepEqual([mov[0][1].p_tipo, mov[0][1].p_quantidade, mov[0][1].p_referencia, mov[0][1].p_empresa], ['entrada', 2, 'cancelamento:mercadolivre:5001:RALO', A])
})

test('venda nova do ML (não Full): baixa pelo serviço oficial, com a referência do pedido (não usa mais a função antiga)', async () => {
  registro.db.ml_orders = []
  registro.axiosGet = async (url) => {
    if (url.includes('/orders/search') && url.includes('order.status=paid') && url.includes('offset=0')) {
      return { data: { results: [{ id: 7001, status: 'paid', date_created: new Date().toISOString(), total_amount: 50, tags: [], shipping: { id: 88, logistic_type: 'drop_off' },
        order_items: [{ item: { id: 'MLB1', seller_sku: 'RALO', title: 'Ralo' }, quantity: 3, sale_fee: 5 }] }], paging: { total: 1 } } }
    }
    if (url.includes('/orders/search')) return { data: { results: [], paging: { total: 0 } } }
    return { data: {} }
  }
  const r = await chamar(app, 'POST', '/api/sync', { headers: { 'x-admin-token': TOKEN_ADMIN } })
  assert.equal(r.status, 200)
  const mov = registro.rpcs.filter(([n]) => n === 'estoque_movimentar')
  assert.ok(mov.length >= 1, 'chamou estoque_movimentar')
  assert.deepEqual([mov[0][1].p_tipo, mov[0][1].p_quantidade, mov[0][1].p_referencia, mov[0][1].p_origem], ['saida', 3, 'venda:mercadolivre:7001:RALO', 'venda_mercadolivre'])
  assert.ok(!registro.rpcs.some(([n]) => n === 'decrementar_estoque_central'), 'função antiga não é mais chamada')
  assert.ok(!registro.ops.some((o) => o.tabela === 'products' && o.payload && 'estoque_atual' in o.payload), 'ninguém grava estoque_atual direto')
})

test('importar produtos do ML: produto que já existe NÃO tem o estoque sobrescrito; produto novo começa com o número do anúncio', async () => {
  registro.axiosGet = async (url) => {
    if (url.includes('/items/search')) return url.includes('scroll_id') ? { data: { results: [] } } : { data: { results: ['MLB1', 'MLB2'], scroll_id: 's1' } }
    if (url.includes('/items?ids=')) return { data: [
      { code: 200, body: { id: 'MLB1', title: 'Existe', available_quantity: 7, attributes: [{ id: 'SELLER_SKU', value_name: 'EXISTE' }] } },
      { code: 200, body: { id: 'MLB2', title: 'Novo', available_quantity: 9, attributes: [{ id: 'SELLER_SKU', value_name: 'NOVO' }] } }] }
    return { data: {} }
  }
  await chamar(app, 'POST', '/api/ml/import-products', { headers: { 'x-admin-token': TOKEN_ADMIN }, body: { empresa_id: A } })
  for (let i = 0; i < 40; i++) { await espera(100); const st = JSON.parse((await chamar(app, 'GET', '/api/ml/import-products/status', { headers: { 'x-admin-token': TOKEN_ADMIN } })).texto); if (!st.running && st.terminadoEm) break }
  const existe = registro.db.products.find((p) => p.sku === 'EXISTE')
  assert.equal(existe.estoque_atual, 42, 'estoque oficial mantido'); assert.equal(existe.name, 'Existe', 'nome atualizado')
  const novo = registro.db.products.find((p) => p.sku === 'NOVO')
  assert.equal(novo.estoque_atual, 9); assert.equal(novo.empresa_id, A)
  assert.equal(registro.db.product_ml_links.length, 2, 'vínculos criados')
})

test('/api/sync-estoque com sessão confere SÓ a empresa da sessão (não grava divergência em massa de todas)', async () => {
  const r = await chamar(app, 'POST', '/api/sync-estoque', { headers: { authorization: 'Bearer tok-a' }, body: { empresa_id: B } })
  assert.equal(r.status, 200)
  assert.ok(JSON.parse(r.texto).conferencia)
  await espera(100)
  assert.ok(!registro.ops.some((o) => o.tabela === 'estoque_divergencias' && o.acao === 'insert'), 'nenhuma inserção direta de divergência')
})

test('rotas /api/estoque exigem sessão de administrador', async () => {
  assert.equal((await chamar(app, 'GET', '/api/estoque/painel')).status, 401)
  assert.equal((await chamar(app, 'POST', '/api/estoque/ajustar', { body: { sku: 'X', novo_estoque: 1 } })).status, 401)
})
