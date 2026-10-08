-- TMP10 — Migração 23: índices para o painel do Estoque Central (divergências)
--
-- POR QUÊ
--   GET /api/estoque/painel buscava as divergências atuais com o filtro "resolvido is null or resolvido = false".
--   Com esse OR o banco não consegue usar índice parcial e lê a tabela inteira (≈ 222 mil linhas antigas) a cada
--   abertura da tela Estoque → "canceling statement due to statement timeout".
--   O backend novo usa o filtro equivalente NOT (resolvido IS TRUE) (mesmo resultado: aberta = falso ou vazio),
--   e estes 2 índices fazem a consulta ler só o que precisa.
--
-- O QUE FAZ
--   Cria 2 índices PARCIAIS em estoque_divergencias. Não apaga, não altera e não move nenhuma linha.
--   Não mexe em estoque, fila, vínculos, RLS nem permissões.
--     • estoque_divergencias_painel_idx  — divergências ATUAIS (com chave) abertas, por empresa, mais repetidas primeiro
--     • estoque_divergencias_legado_idx  — divergências ANTIGAS (sem chave) abertas, por empresa (só para a contagem)
--   Durante a criação (≈ 1 segundo com 222 mil linhas) gravações nessa tabela esperam; leituras seguem normais.
--   Se a tabela estiver ocupada por mais de 10 s, o comando desiste sem mudar nada (lock_timeout) — é só rodar de novo.
--
-- COMO APLICAR: Supabase → SQL Editor → cole o arquivo inteiro → Run. Pode rodar mais de uma vez.
-- DEPOIS (recomendado, opcional, não altera dados): rode SOZINHO, numa consulta separada:
--     vacuum (analyze) public.estoque_divergencias;
-- PARA DESFAZER: 23-estoque-divergencias-indices-reverter.sql (apaga só os 2 índices).

begin;
set local lock_timeout = '10s';
set local statement_timeout = '10min';

create index if not exists estoque_divergencias_painel_idx
  on public.estoque_divergencias (empresa_id, ocorrencias desc)
  where chave is not null and resolvido is not true;

create index if not exists estoque_divergencias_legado_idx
  on public.estoque_divergencias (empresa_id)
  where chave is null and resolvido is not true;

analyze public.estoque_divergencias;
commit;

-- CONFERÊNCIA (só leitura) — deve listar os 2 índices novos:
-- select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'estoque_divergencias' order by 1;
