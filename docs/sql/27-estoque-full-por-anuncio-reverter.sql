-- TMP10 — REVERTER a migração 27 (estoque Full por anúncio).
-- ATENÇÃO: apaga o HISTÓRICO de consultas Full. NÃO mexe em products, estoque_movimentos, fila, vínculos nem agrupamentos.
-- O backend continua funcionando sem a 27: a tela mostra o estoque normal e o Full como "pendente (migração 27 não aplicada)".
begin;
drop function if exists public.estoque_saldo_normal_resumo(uuid, text[]);
drop function if exists public.estoque_full_registrar(uuid, jsonb, uuid);
drop table if exists public.estoque_full_leituras;
drop table if exists public.estoque_full_saldos;
drop function if exists public.estoque_full_imutavel();
commit;
notify pgrst, 'reload schema';
