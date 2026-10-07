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

const registro = { ops: [], crons: 0, dados: {}, db: {}, falhas: {}, seq: 0, auth: { tokens: {}, chamadas: [], erro: null }, axiosGet: null, axiosPost: null, logs }

function aplicarFiltros(linhas, filtros) {
  return linhas.filter((r) => filtros.every(([m, col, val]) => {
    if (m === 'eq') return r[col] === val
    if (m === 'neq') return r[col] !== val
    if (m === 'in') return Array.isArray(val) && val.includes(r[col])
    if (m === 'lt') return r[col] < val
    if (m === 'lte') return r[col] <= val
    if (m === 'gt') return r[col] > val
    if (m === 'gte') return r[col] >= val
    return true
  }))
}

function criarQuery(tabela) {
  const q = { tabela, filtros: [], acao: 'select', payload: null, erroForcado: null }
  const cadeia = ['select', 'eq', 'neq', 'in', 'order', 'limit', 'gte', 'lte', 'not', 'gt', 'lt', 'is', 'range', 'ilike', 'or', 'filter', 'match']
  for (const m of cadeia) q[m] = (...args) => { if (m !== 'select' || q.acao === 'select') q.filtros.push([m, ...args]); return q }
  for (const m of ['insert', 'update', 'upsert', 'delete']) {
    q[m] = (payload, opcoes) => { q.acao = m; q.payload = payload; q.opcoes = opcoes || {}; registro.ops.push({ tabela, acao: m, payload, filtros: q.filtros, opcoes: q.opcoes }); return q }
  }
  const resultado = () => {
    // Banco em memória (registro.db) — usado pelos testes da conta central
    if (registro.db[tabela]) {
      const linhas = registro.db[tabela]
      if (registro.falhas[`${tabela}.${q.acao}`]) return { data: null, error: registro.falhas[`${tabela}.${q.acao}`] }
      if (q.acao === 'insert') {
        const novos = (Array.isArray(q.payload) ? q.payload : [q.payload]).map((r) => ({ id: 'id-' + (++registro.seq), ...r }))
        for (const n of novos) {
          if (n.email && linhas.some((x) => (x.email || '').toLowerCase() === n.email.toLowerCase())) return { data: null, error: { code: '23505', message: 'duplicate key' } }
        }
        linhas.push(...novos)
        return { data: novos, error: null }
      }
      if (q.acao === 'upsert') {
        const chave = (q.opcoes && q.opcoes.onConflict) || 'id'
        for (const n of (Array.isArray(q.payload) ? q.payload : [q.payload])) {
          const cols = String(chave).split(',').map((c) => c.trim())
          const existente = linhas.find((r) => cols.every((c) => r[c] !== undefined && r[c] === n[c]))
          if (existente) Object.assign(existente, n); else linhas.push({ id: 'id-' + (++registro.seq), ...n })
        }
        return { data: q.payload, error: null }
      }
      const alvo = aplicarFiltros(linhas, q.filtros)
      if (q.acao === 'update') { for (const r of alvo) Object.assign(r, q.payload); return { data: alvo, error: null } }
      if (q.acao === 'delete') { registro.db[tabela] = linhas.filter((r) => !alvo.includes(r)); return { data: alvo, error: null } }
      return { data: alvo.map((r) => ({ ...r })), error: null, count: alvo.length }
    }
    const linhas = typeof registro.dados[tabela] === 'function' ? registro.dados[tabela](q) : (registro.dados[tabela] || [])
    return { data: linhas, error: null, count: Array.isArray(linhas) ? linhas.length : 0 }
  }
  q.maybeSingle = () => Promise.resolve(resultado()).then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] || null) : r.data }))
  q.single = q.maybeSingle
  q.then = (ok, falha) => Promise.resolve(resultado()).then(ok, falha)
  return q
}

// Supabase Auth simulado: tokens válidos em registro.auth.tokens { token: authUserId }
const authFake = {
  getUser: async (token) => {
    const id = registro.auth.tokens[token]
    return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid JWT' } }
  },
  admin: {
    createUser: async (dados) => { registro.auth.chamadas.push(['createUser', dados]); if (registro.auth.erro) return { data: null, error: registro.auth.erro }; const id = 'auth-' + (++registro.seq); (registro.auth.emails = registro.auth.emails || {})[id] = dados.email; return { data: { user: { id } }, error: null } },
    getUserById: async (id) => ({ data: { user: { id, email: (registro.auth.emails || {})[id] || null } }, error: null }),
    inviteUserByEmail: async (email, op) => { registro.auth.chamadas.push(['invite', email, op]); if (registro.auth.erro) return { data: null, error: registro.auth.erro }; return { data: { user: { id: 'auth-' + (++registro.seq) } }, error: null } },
    updateUserById: async (id, dados) => { registro.auth.chamadas.push(['update', id, dados]); return { data: {}, error: null } },
    deleteUser: async (id) => { registro.auth.chamadas.push(['delete', id]); return { data: {}, error: null } }
  },
  signInWithPassword: async (dados) => {
    registro.auth.chamadas.push(['signIn', dados.email])
    return registro.auth.falhaLogin ? { data: {}, error: { message: 'x' } } : { data: { session: { access_token: 'at-' + dados.email, refresh_token: 'rt', expires_in: 3600, expires_at: 999 } }, error: null }
  }
}

const fakes = {
  '@supabase/supabase-js': { createClient: () => ({ from: (t) => criarQuery(t), rpc: async (nome, args) => { (registro.rpcs = registro.rpcs || []).push([nome, args]); return registro.rpc && registro.rpc[nome] ? registro.rpc[nome](args) : { data: null, error: null } }, storage: { from: () => ({}) }, auth: authFake }) },
  'node-cron': { schedule: () => { registro.crons++; return { stop() {} } } },
  'web-push': {
    setVapidDetails() {},
    // registro.push = { enviados: [[inscricao, payload, opcoes]], erros: { <endpoint>: { statusCode, body } } }
    sendNotification: async (inscricao, payload, opcoes) => {
      const p = registro.push || (registro.push = { enviados: [], erros: {} })
      const erro = (p.erros || {})[inscricao.endpoint]
      if (erro) { const e = new Error('push falhou'); Object.assign(e, erro); throw e }
      p.enviados.push([inscricao, payload, opcoes])
      return { statusCode: 201 }
    }
  },
  axios: {
    get: (url, ...r) => (registro.axiosGet ? registro.axiosGet(url, ...r) : Promise.reject(new Error('rede bloqueada no teste'))),
    post: (url, ...r) => (registro.axiosPost ? registro.axiosPost(url, ...r) : Promise.reject(new Error('rede bloqueada no teste'))),
    put: (url, ...r) => (registro.axiosPut ? registro.axiosPut(url, ...r) : Promise.reject(new Error('rede bloqueada no teste')))
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
    SUPABASE_PUBLIC_KEY: 'sb_publishable_teste',
    CADASTRO_LIMITE_POR_HORA: '1000',
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
        res.on('end', () => resolve({ status: res.statusCode, texto: txt, location: res.headers.location, headers: res.headers }))
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
