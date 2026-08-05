# TMP10 Backend

Backend Node.js do sistema TMP10 — integração com Mercado Livre (e Shopee), sincronização automática de pedidos, estoque, notificações push e mais.

## Deploy no Railway

1. Cria um novo projeto no Railway, conectado a este repositório
2. Em **Settings → Variables**, copia todas as variáveis do arquivo `.env.example` e preenche com os valores reais (pega do Supabase, do app Mercado Livre em open.mercadolivre.com.br, etc)
3. O Railway detecta automaticamente que é um projeto Node (por causa do `railway.toml` e `nixpacks.toml`) e builda sozinho
4. Depois do primeiro deploy, testa abrindo a URL gerada pelo Railway no navegador — deve aparecer um JSON de status tipo `{"status":"🚀 TMP10 Backend..."}`

## Estrutura

- `server.js` — todo o backend (rotas Express, sincronização com Mercado Livre, cron jobs, push notifications)
- `package.json` — dependências e comando de start
- `railway.toml` — configuração do builder (Nixpacks) e comando de deploy
- `nixpacks.toml` — força o Nixpacks a reconhecer esse projeto como Node.js, mesmo se outros arquivos não-Node aparecerem no repositório no futuro
- `.env.example` — lista de variáveis de ambiente necessárias (não sobe o `.env` de verdade pro Git)

## Importante

Este repositório é só para o backend do TMP10. Não junta arquivos de outros projetos (Python, outros bots, etc) aqui dentro — isso já causou problema de detecção de builder no Railway antes.
