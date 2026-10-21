-- TMP10 — REVERTER a migração 26 (agrupamento de anúncios).
-- ATENÇÃO: apaga o HISTÓRICO de agrupamentos. NÃO mexe em estoque, vendas ou movimentos (nada disso foi alterado pela 26).
-- Antes, volte o backend para a versão sem agrupamento: sem a tabela, o backend novo trata todos os SKUs como não agrupados.
-- Exporte as duas tabelas (CSV) antes, se quiser guardar o histórico.
begin;
drop trigger if exists estoque_agrupamento_protegido on public.estoque_agrupamento;
drop trigger if exists estoque_agrupamento_sem_truncate on public.estoque_agrupamento;
drop trigger if exists estoque_agrupamento_eventos_protegido on public.estoque_agrupamento_eventos;
drop trigger if exists estoque_agrupamento_eventos_sem_truncate on public.estoque_agrupamento_eventos;
drop function if exists public.estoque_agrupamento_aplicar(uuid, uuid, text, uuid, text, jsonb, bigint[], jsonb);
drop table if exists public.estoque_agrupamento;
drop table if exists public.estoque_agrupamento_eventos;
drop function if exists public.estoque_agrupamento_protegido();
commit;
