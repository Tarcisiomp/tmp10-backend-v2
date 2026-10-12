-- TMP10 — Migração 24: AJUSTE EM MASSA DE ESTOQUE (Marketplace → TMP10) — auditoria imutável + trava por empresa
--
-- O QUE FAZ (só ACRESCENTA; não apaga, não altera e não move nenhuma linha existente):
--   • estoque_ajuste_massa_execucoes — uma linha por SIMULAÇÃO: empresa, usuário, conta de origem, lista simulada (snapshot),
--     resumo e validade. A confirmação/execução só aceita uma simulação válida desta tabela.
--   • estoque_ajuste_massa_eventos  — um EVENTO por resultado de item (simulado, igual, bloqueado, aplicado, ja_aplicado, falha),
--     com tentativa, motivo, detalhe e o movimento gerado. SEM índice único: retomadas acrescentam eventos, nunca sobrescrevem.
--   • estoque_ajuste_massa_trava    — uma linha por empresa enquanto uma execução roda (validade curta; expira sozinha).
--   • 3 funções da trava: estoque_ajuste_massa_travar / _renovar / _liberar (operação atômica no banco).
--
-- PROTEÇÃO DA AUDITORIA:
--   • RLS ligado, sem policy; o navegador (anon/authenticated) não tem acesso nenhum.
--   • O backend (service_role) só pode LER e INSERIR nas duas tabelas de auditoria (sem UPDATE/DELETE/TRUNCATE).
--   • Gatilhos recusam UPDATE, DELETE e TRUNCATE nas duas tabelas de auditoria, para qualquer usuário.
--
-- O ESTOQUE NÃO É ALTERADO AQUI. A idempotência do ajuste vem do índice único que JÁ EXISTE em estoque_movimentos
-- (empresa_id, referencia) — o backend usa a referência massa:{execução}:{sku}.
--
-- COMO APLICAR: Supabase → SQL Editor → cole o arquivo inteiro → Run. Pode rodar mais de uma vez.
-- PARA DESFAZER: 24-estoque-ajuste-massa-reverter.sql (ATENÇÃO: apaga o histórico de auditoria do ajuste em massa).

begin;
set local lock_timeout = '10s';

create table if not exists public.estoque_ajuste_massa_execucoes (
  id uuid primary key,
  empresa_id uuid not null,
  usuario_id uuid,
  plataforma text not null check (plataforma in ('mercadolivre')),
  conta_ref text not null,
  conta_nome text,
  limite_quantidade integer not null,
  itens jsonb not null,                 -- snapshot da simulação: [{sku, produto_id, situacao, tmp10_antes, novo, numero_lido, anuncio_origem, motivo}]
  resumo jsonb not null,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null
);
create index if not exists estoque_ajuste_massa_execucoes_empresa_idx on public.estoque_ajuste_massa_execucoes (empresa_id, criado_em desc);

create table if not exists public.estoque_ajuste_massa_eventos (
  id bigint generated always as identity primary key,
  execucao_id uuid not null references public.estoque_ajuste_massa_execucoes (id),
  empresa_id uuid not null,
  usuario_id uuid,
  modo text not null check (modo in ('simulacao', 'execucao')),
  tentativa integer not null default 1,
  sku text not null,
  produto_id uuid,
  plataforma text,
  conta_ref text,
  anuncio_id text,
  numero_lido integer,
  estoque_anterior integer,
  estoque_novo integer,
  resultado text not null check (resultado in ('simulado', 'igual', 'bloqueado', 'aplicado', 'ja_aplicado', 'falha')),
  motivo text,
  detalhe jsonb,
  movimento_id uuid,
  criado_em timestamptz not null default now()
);
create index if not exists estoque_ajuste_massa_eventos_execucao_idx on public.estoque_ajuste_massa_eventos (execucao_id, sku, id);
create index if not exists estoque_ajuste_massa_eventos_empresa_idx on public.estoque_ajuste_massa_eventos (empresa_id, criado_em desc);

create table if not exists public.estoque_ajuste_massa_trava (
  empresa_id uuid primary key,
  execucao_id uuid not null,
  dono text not null,
  expira_em timestamptz not null,
  criado_em timestamptz not null default now()
);

-- Auditoria imutável -------------------------------------------------------------------------------------------------
create or replace function public.estoque_ajuste_massa_imutavel()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'auditoria do ajuste em massa é imutável: % não permitido em %', tg_op, tg_table_name;
end $$;

drop trigger if exists estoque_ajuste_massa_execucoes_imutavel on public.estoque_ajuste_massa_execucoes;
create trigger estoque_ajuste_massa_execucoes_imutavel before update or delete on public.estoque_ajuste_massa_execucoes
  for each row execute function public.estoque_ajuste_massa_imutavel();
drop trigger if exists estoque_ajuste_massa_execucoes_sem_truncate on public.estoque_ajuste_massa_execucoes;
create trigger estoque_ajuste_massa_execucoes_sem_truncate before truncate on public.estoque_ajuste_massa_execucoes
  for each statement execute function public.estoque_ajuste_massa_imutavel();
drop trigger if exists estoque_ajuste_massa_eventos_imutavel on public.estoque_ajuste_massa_eventos;
create trigger estoque_ajuste_massa_eventos_imutavel before update or delete on public.estoque_ajuste_massa_eventos
  for each row execute function public.estoque_ajuste_massa_imutavel();
drop trigger if exists estoque_ajuste_massa_eventos_sem_truncate on public.estoque_ajuste_massa_eventos;
create trigger estoque_ajuste_massa_eventos_sem_truncate before truncate on public.estoque_ajuste_massa_eventos
  for each statement execute function public.estoque_ajuste_massa_imutavel();

-- Trava por empresa (pega só se não houver trava ou se a anterior venceu) ------------------------------------------------
create or replace function public.estoque_ajuste_massa_travar(p_empresa uuid, p_execucao uuid, p_dono text, p_segundos integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if p_empresa is null or p_execucao is null or coalesce(p_dono, '') = '' then raise exception 'trava: parâmetros obrigatórios'; end if;
  insert into estoque_ajuste_massa_trava (empresa_id, execucao_id, dono, expira_em)
  values (p_empresa, p_execucao, p_dono, now() + make_interval(secs => greatest(coalesce(p_segundos, 120), 10)))
  on conflict (empresa_id) do update
     set execucao_id = excluded.execucao_id, dono = excluded.dono, expira_em = excluded.expira_em, criado_em = now()
   where estoque_ajuste_massa_trava.expira_em < now();
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create or replace function public.estoque_ajuste_massa_renovar(p_empresa uuid, p_execucao uuid, p_dono text, p_segundos integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  update estoque_ajuste_massa_trava set expira_em = now() + make_interval(secs => greatest(coalesce(p_segundos, 120), 10))
   where empresa_id = p_empresa and execucao_id = p_execucao and dono = p_dono;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

create or replace function public.estoque_ajuste_massa_liberar(p_empresa uuid, p_execucao uuid, p_dono text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  delete from estoque_ajuste_massa_trava where empresa_id = p_empresa and execucao_id = p_execucao and dono = p_dono;
  get diagnostics v_n = row_count;
  return v_n = 1;
end $$;

-- Segurança -------------------------------------------------------------------------------------------------------------
alter table public.estoque_ajuste_massa_execucoes enable row level security;
alter table public.estoque_ajuste_massa_eventos enable row level security;
alter table public.estoque_ajuste_massa_trava enable row level security;
revoke all on public.estoque_ajuste_massa_execucoes, public.estoque_ajuste_massa_eventos, public.estoque_ajuste_massa_trava from public, anon, authenticated, service_role;
grant select, insert on public.estoque_ajuste_massa_execucoes, public.estoque_ajuste_massa_eventos to service_role;
grant select on public.estoque_ajuste_massa_trava to service_role;
grant usage on sequence public.estoque_ajuste_massa_eventos_id_seq to service_role;

revoke all on function public.estoque_ajuste_massa_imutavel() from public, anon, authenticated;
revoke all on function public.estoque_ajuste_massa_travar(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.estoque_ajuste_massa_renovar(uuid, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.estoque_ajuste_massa_liberar(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.estoque_ajuste_massa_travar(uuid, uuid, text, integer) to service_role;
grant execute on function public.estoque_ajuste_massa_renovar(uuid, uuid, text, integer) to service_role;
grant execute on function public.estoque_ajuste_massa_liberar(uuid, uuid, text) to service_role;

commit;

-- CONFERÊNCIA (só leitura), depois de aplicar:
-- select table_name, privilege_type, grantee from information_schema.role_table_grants
--  where table_name like 'estoque_ajuste_massa%' order by 1, 3, 2;     -- service_role: só SELECT/INSERT (e SELECT na trava)
