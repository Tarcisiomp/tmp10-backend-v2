// Ambiente de teste: substitui Supabase, Mercado Livre/Shopee (axios), web-push e cron por simulações.
// Nada aqui acessa a internet nem o banco de produção.
const Module = require('module')

// Os logs do servidor vão para um buffer (e não para a saída padrão, que o executor de testes usa
// para se comunicar). Se um teste falhar, dá para inspecionar registro.logs.
const util = require('util')
const logs = []
for (const nivel of ['log', 'info', 'warn', 'error']) {
  console[nivel] = (...args) => { logs.push(util.format(...args)) }
}

const registro = { ops: [], crons: 0, dados: {}, axiosGet: null, logs }

function criarQuery(tabela) {
  const q = { tabela, filtros: [], acao: 'select', payload: null }
  const cadeia = ['select', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte', 'not', 'gt', 'lt', 'is', 'range', 'ilike', 'or', 'filter', 'match']
  for (const m of cadeia) q[m] = (...args) => { q.filtros.push([m, ...args]); return q }
  for (const m of ['insert', 'update', 'upsert', 'delete']) {
    q[m] = (payload) => { q.acao = m; q.payload = payload; registro.ops.push({ tabela, acao: m, payload }); return q }
  }
  const resultado = () => {
    const linhas = typeof registro.dados[tabela] === 'function' ? registro.dados[tabela](q) : (registro.dados[tabela] || [])
    return { data: linhas, error: null, count: Array.isArray(linhas) ? linhas.length : 0 }
  }
  q.maybeSingle = () => Promise.resolve({ ...resultado(), data: (resultado().data || [])[0] || null })
  q.single = q.maybeSingle
  q.then = (ok, falha) => Promise.resolve(resultado()).then(ok, falha)
  return q
}

const fakes = {
  '@supabase/supabase-js': { createClient: () => ({ from: (t) => criarQuery(t), rpc: async () => ({ data: null, error: null }), storage: { from: () => ({}) } }) },
  'node-cron': { schedule: () => { registro.crons++; return { stop() {} } } },
  'web-push': { setVapidDetails() {}, sendNotification: async () => ({}) },
  axios: {
    get: (url, ...r) => (registro.axiosGet ? registro.axiosGet(url, ...r) : Promise.reject(new Error('rede bloqueada no teste'))),
    post: () => Promise.reject(new Error('rede bloqueada no teste')),
    put: () => Promise.reject(new Error('rede bloqueada no teste'))
  }
}
const loadOriginal = Module._load
Module._load = function (pedido, ...resto) {
  if (Object.prototype.hasOwnProperty.call(fakes, pedido)) return fakes[pedido]
  return loadOriginal.call(this, pedido, ...resto)
}

const TOKEN_ADMIN = 'teste-token-admin-0123456789abcdef0123456789'
function envTeste(extra = {}) {
  Object.assign(process.env, {
    SUPABASE_SERVICE_KEY: 'chave-falsa-de-teste',
    ML_CLIENT_SECRET: 'secret-falso-de-teste',
    VAPID_PUBLIC_KEY: 'publica-falsa',
    VAPID_PRIVATE_KEY: 'privada-falsa',
    ADMIN_API_TOKEN: TOKEN_ADMIN,
    PORT: '0',
    ...extra
  })
}

// Faz uma requisição HTTP ao app (servidor efêmero em porta aleatória)
async function chamar(app, metodo, caminho, { headers = {}, body } = {}) {
  const http = require('http')
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)) })
  try {
    const porta = srv.address().port
    return await new Promise((resolve, reject) => {
      const dados = body ? JSON.stringify(body) : null
      const req = http.request({ host: '127.0.0.1', port: porta, method: metodo, path: caminho,
        headers: { ...(dados ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
        let txt = ''
        res.on('data', (c) => { txt += c })
        res.on('end', () => resolve({ status: res.statusCode, texto: txt, location: res.headers.location }))
      })
      req.on('error', reject)
      if (dados) req.write(dados)
      req.end()
    })
  } finally {
    srv.close()
  }
}

module.exports = { registro, envTeste, chamar, TOKEN_ADMIN }
