-- TMP10 — DESFAZ a migração 23: apaga só os 2 índices. Nenhuma linha muda.
-- Atenção: sem eles, o painel volta a ler a tabela inteira de divergências.
drop index if exists public.estoque_divergencias_painel_idx;
drop index if exists public.estoque_divergencias_legado_idx;
