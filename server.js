Encontrei um erro na autorização Shopee Sandbox:

{"error":"error_sign","message":"Wrong sign"}

O Partner ID já está sendo aceito, então não é mais error_param.

Revise especificamente a implementação Shopee OAuth v2 no server.js.

O código atual tem:

const SHOPEE_HOST = process.env.SHOPEE_HOST || 'https://partner.test-stable.shopeemobile.com'

function shopeeSign(path, timestamp, accessToken = '', shopId = '') {
  const baseString = `${SHOPEE_PARTNER_ID}${path}${timestamp}${accessToken}${shopId}`
  return crypto.createHmac('sha256', SHOPEE_PARTNER_KEY).update(baseString).digest('hex')
}

Para /api/v2/shop/auth_partner a assinatura deve ser calculada usando somente:
partner_id + path + timestamp

Não altere o fluxo do Mercado Livre.
Não altere as outras funções do sistema.
Não remova nenhuma funcionalidade existente.

Primeiro analise o código atual e confirme:
1. qual Partner ID está sendo lido;
2. se a Partner Key está sendo lida corretamente do Railway;
3. qual valor exato está sendo usado como path;
4. qual host Sandbox está sendo usado;
5. qual string está sendo assinada;
6. se existe algum problema de espaço, aspas, prefixo ou conversão na Partner Key;
7. se o timestamp está correto.

Não mostre nem imprima a Partner Key nos logs.

Depois faça somente a correção necessária para o OAuth Shopee Sandbox.

IMPORTANTE:
Não troque o host automaticamente apenas por tentativa.
Pesquise/verifique qual endpoint Sandbox é correto para o fluxo /api/v2/shop/auth_partner antes de alterar.

Depois me mostre exatamente quais linhas foram alteradas.
