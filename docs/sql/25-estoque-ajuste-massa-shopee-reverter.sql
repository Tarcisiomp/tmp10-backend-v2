-- TMP10 — REVERTER a migração 25 (volta a aceitar só 'mercadolivre').
-- ATENÇÃO: falha (de propósito) se já existir simulação da Shopee ou multi gravada — o histórico é imutável e não é apagado.
begin;
alter table public.estoque_ajuste_massa_execucoes drop constraint if exists estoque_ajuste_massa_execucoes_plataforma_check;
alter table public.estoque_ajuste_massa_execucoes
  add constraint estoque_ajuste_massa_execucoes_plataforma_check check (plataforma in ('mercadolivre'));
commit;
