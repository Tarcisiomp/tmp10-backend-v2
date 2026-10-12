-- TMP10 — REVERTER a migração 24 (ajuste em massa).
-- ATENÇÃO: isto APAGA o histórico de auditoria do ajuste em massa (simulações, bloqueios, aplicações).
-- NÃO desfaz estoques já alterados: cada ajuste aplicado continua em estoque_movimentos (origem 'ajuste_massa').
-- Só rode se você decidir explicitamente abrir mão desse histórico. Antes, exporte as duas tabelas (CSV).
begin;
drop trigger if exists estoque_ajuste_massa_eventos_imutavel on public.estoque_ajuste_massa_eventos;
drop trigger if exists estoque_ajuste_massa_eventos_sem_truncate on public.estoque_ajuste_massa_eventos;
drop trigger if exists estoque_ajuste_massa_execucoes_imutavel on public.estoque_ajuste_massa_execucoes;
drop trigger if exists estoque_ajuste_massa_execucoes_sem_truncate on public.estoque_ajuste_massa_execucoes;
drop function if exists public.estoque_ajuste_massa_travar(uuid, uuid, text, integer);
drop function if exists public.estoque_ajuste_massa_renovar(uuid, uuid, text, integer);
drop function if exists public.estoque_ajuste_massa_liberar(uuid, uuid, text);
drop table if exists public.estoque_ajuste_massa_trava;
drop table if exists public.estoque_ajuste_massa_eventos;
drop table if exists public.estoque_ajuste_massa_execucoes;
drop function if exists public.estoque_ajuste_massa_imutavel();
commit;
