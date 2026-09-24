// Configuração do backend — lida SOMENTE das variáveis de ambiente (Railway → Variables).
// Nenhum segredo pode ficar escrito no código. Se faltar uma variável obrigatória,
// o servidor NÃO inicia (melhor parar com mensagem clara do que rodar inseguro).
// Os valores nunca são impressos no log — só os nomes que estão faltando.

const OBRIGATORIAS = [
  'SUPABASE_SERVICE_KEY', // chave service_role do Supabase (secreta)
  'ML_CLIENT_SECRET',     // secret do app Mercado Livre (secreta)
  'VAPID_PUBLIC_KEY',     // chave pública das notificações push
  'VAPID_PRIVATE_KEY',    // chave privada das notificações push (secreta)
  'ADMIN_API_TOKEN'       // token das rotas de manutenção/admin (secreto, mínimo 32 caracteres)
]

function lerConfig(env = process.env) {
  const faltando = OBRIGATORIAS.filter((nome) => !String(env[nome] || '').trim())
  if (faltando.length) {
    const erro = new Error(`Variáveis de ambiente obrigatórias não configuradas: ${faltando.join(', ')}`)
    erro.code = 'CONFIG_FALTANDO'
    erro.faltando = faltando
    throw erro
  }
  const adminToken = String(env.ADMIN_API_TOKEN).trim()
  if (adminToken.length < 32) {
    const erro = new Error('ADMIN_API_TOKEN precisa ter pelo menos 32 caracteres')
    erro.code = 'CONFIG_INVALIDA'
    throw erro
  }
  const modo = String(env.ADMIN_ROUTES_MODE || 'enforce').trim().toLowerCase()
  if (!['enforce', 'report'].includes(modo)) {
    const erro = new Error('ADMIN_ROUTES_MODE deve ser "enforce" ou "report"')
    erro.code = 'CONFIG_INVALIDA'
    throw erro
  }
  return {
    // Não são segredos (identificadores públicos) — podem ter valor padrão.
    SUPABASE_URL: String(env.SUPABASE_URL || 'https://foshqdjgbcigggrcjtap.supabase.co').trim(),
    ML_CLIENT_ID: String(env.ML_CLIENT_ID || '4022957335913783').trim(),
    // Segredos — só do ambiente.
    SUPABASE_SERVICE_KEY: String(env.SUPABASE_SERVICE_KEY).trim(),
    ML_CLIENT_SECRET: String(env.ML_CLIENT_SECRET).trim(),
    VAPID_PUBLIC_KEY: String(env.VAPID_PUBLIC_KEY).trim(),
    VAPID_PRIVATE_KEY: String(env.VAPID_PRIVATE_KEY).trim(),
    ADMIN_API_TOKEN: adminToken,
    ADMIN_ROUTES_MODE: modo
  }
}

module.exports = { lerConfig, OBRIGATORIAS }
