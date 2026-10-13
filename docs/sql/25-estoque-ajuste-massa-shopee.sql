-- TMP10 — Migração 25: Ajuste em Massa também para a SHOPEE (e para as duas plataformas juntas).
-- Pré-requisito: migração 24 aplicada.
-- O que muda: só a regra (CHECK) da coluna plataforma do cabeçalho das simulações, que passa a aceitar
--   'mercadolivre', 'shopee' e 'multi' (Mercado Livre + Shopee na mesma simulação).
-- Não mexe em estoque, vínculos, pedidos, fila, configuração, modo PILOTO/ATIVO/DESLIGADO nem em dados existentes.
-- Pode rodar mais de uma vez.
begin;
do $$
declare r record;
begin
  for r in
    select con.conname from pg_constraint con
    join pg_class t on t.oid = con.conrelid join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = 'estoque_ajuste_massa_execucoes' and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%plataforma%'
  loop
    execute format('alter table public.estoque_ajuste_massa_execucoes drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.estoque_ajuste_massa_execucoes
  add constraint estoque_ajuste_massa_execucoes_plataforma_check check (plataforma in ('mercadolivre', 'shopee', 'multi'));
commit;

-- Conferência (deve mostrar a regra nova):
select conname, pg_get_constraintdef(oid) from pg_constraint where conname = 'estoque_ajuste_massa_execucoes_plataforma_check';
