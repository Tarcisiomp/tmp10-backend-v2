-- TMP10 — Migração 27: ESTOQUE FULL POR ANÚNCIO (Mercado Livre), SEPARADO do estoque normal do TMP10
--
-- PRÉ-REQUISITO: migrações 21 a 26 aplicadas (rode antes 26-PRE-VERIFICACAO-22-a-26-somente-leitura.sql).
--
-- O QUE FAZ (só ACRESCENTA; não apaga, não altera e não move nenhuma linha existente):
--   • estoque_full_saldos   — a ÚLTIMA consulta do saldo Full de cada anúncio (empresa + conta + anúncio + variação).
--   • estoque_full_leituras — HISTÓRICO imutável de todas as consultas (inclusive as que falharam).
--   • estoque_full_registrar(p_empresa, p_leituras) — grava um lote de consultas (histórico + última) numa transação.
--   • estoque_saldo_normal_resumo(p_empresa, p_skus) — data/hora do último movimento APLICADO de cada SKU (só leitura).
--
-- REGRAS GARANTIDAS PELO BANCO:
--   • o saldo Full NUNCA é gravado em products.estoque_atual (nem em nenhuma coluna do estoque normal) — tabelas separadas;
--   • consulta que FALHOU nunca vira zero: com situação ≠ 'atualizado', disponível/não disponível/total TÊM de ser nulos
--     (check). O último valor VÁLIDO fica guardado à parte (valido_*), com a data dele;
--   • o histórico é imutável (UPDATE/DELETE/TRUNCATE recusados, até para o dono);
--   • RLS ligado sem policy: o navegador não tem acesso; o backend (service_role) só LÊ e chama as funções.
--
-- NADA DE ESTOQUE MUDA AQUI. Nenhum saldo é somado, zerado ou copiado.
--
-- COMO APLICAR: Supabase → SQL Editor → cole o arquivo inteiro → Run. Pode rodar mais de uma vez.
-- PARA DESFAZER: 27-estoque-full-por-anuncio-reverter.sql (ATENÇÃO: apaga o histórico de consultas Full).

begin;
set local lock_timeout = '10s';

create table if not exists public.estoque_full_saldos (
  id bigint generated always as identity primary key,
  empresa_id uuid not null,
  plataforma text not null default 'mercadolivre' check (plataforma = 'mercadolivre'),
  conta_ref text not null,                 -- ml_user_id (ou nick:<apelido>) — mesmo formato da fila
  conta_nome text,
  anuncio_id text not null,                -- ml_item_id
  variacao_id text not null default '',
  sku_vinculo text,                        -- SKU do vínculo no momento da consulta (só informação)
  inventory_id text,                       -- campo inventory_id do GET /items/{id} (doc oficial "Envios Fulfillment")
  situacao text not null check (situacao in ('atualizado', 'erro', 'indisponivel', 'sem_full')),
  disponivel integer check (disponivel >= 0),           -- available_quantity
  nao_disponivel integer check (nao_disponivel >= 0),   -- not_available_quantity
  total integer check (total >= 0),                     -- total
  detalhe jsonb,                                        -- not_available_detail (como o ML devolveu)
  erro text,
  consultado_em timestamptz not null,                   -- última TENTATIVA
  valido_disponivel integer, valido_nao_disponivel integer, valido_total integer,
  valido_em timestamptz,                                -- data do último valor VÁLIDO (preservado se a consulta seguinte falhar)
  check ((situacao = 'atualizado' and disponivel is not null and total is not null)
      or (situacao <> 'atualizado' and disponivel is null and nao_disponivel is null and total is null))
);
create unique index if not exists estoque_full_saldos_anuncio_uq on public.estoque_full_saldos (empresa_id, conta_ref, anuncio_id, variacao_id);
create index if not exists estoque_full_saldos_anuncio_idx on public.estoque_full_saldos (empresa_id, anuncio_id);

create table if not exists public.estoque_full_leituras (
  id bigint generated always as identity primary key,
  empresa_id uuid not null,
  conta_ref text not null,
  anuncio_id text not null,
  variacao_id text not null default '',
  sku_vinculo text,
  inventory_id text,
  situacao text not null check (situacao in ('atualizado', 'erro', 'indisponivel', 'sem_full')),
  disponivel integer, nao_disponivel integer, total integer, detalhe jsonb, erro text,
  consultado_em timestamptz not null,
  usuario_id uuid,
  criado_em timestamptz not null default now(),
  check ((situacao = 'atualizado' and disponivel is not null and total is not null)
      or (situacao <> 'atualizado' and disponivel is null and nao_disponivel is null and total is null))
);
create index if not exists estoque_full_leituras_anuncio_idx on public.estoque_full_leituras (empresa_id, conta_ref, anuncio_id, variacao_id, consultado_em desc);

create or replace function public.estoque_full_imutavel()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'estoque_full_leituras: histórico imutável (%)', tg_op using errcode = '42501';
end $$;
drop trigger if exists estoque_full_leituras_imutavel on public.estoque_full_leituras;
create trigger estoque_full_leituras_imutavel before update or delete on public.estoque_full_leituras
  for each row execute function public.estoque_full_imutavel();
drop trigger if exists estoque_full_leituras_sem_truncate on public.estoque_full_leituras;
create trigger estoque_full_leituras_sem_truncate before truncate on public.estoque_full_leituras
  for each statement execute function public.estoque_full_imutavel();

-- Grava um LOTE de consultas: p_leituras = [{conta_ref, conta_nome, anuncio_id, variacao_id, sku_vinculo, inventory_id, situacao,
--   disponivel, nao_disponivel, total, detalhe, erro, consultado_em}]. Tudo ou nada.
create or replace function public.estoque_full_registrar(p_empresa uuid, p_leituras jsonb, p_usuario uuid default null)
returns integer language plpgsql security definer set search_path = public as $$
declare
  l jsonb; n integer := 0; v_ok boolean; v_quando timestamptz;
begin
  if p_empresa is null then raise exception 'estoque_full: empresa obrigatória' using errcode = '22023'; end if;
  for l in select * from jsonb_array_elements(coalesce(p_leituras, '[]'::jsonb)) loop
    v_ok := (l->>'situacao') = 'atualizado';
    v_quando := coalesce((l->>'consultado_em')::timestamptz, now());
    insert into estoque_full_leituras (empresa_id, conta_ref, anuncio_id, variacao_id, sku_vinculo, inventory_id, situacao,
      disponivel, nao_disponivel, total, detalhe, erro, consultado_em, usuario_id)
    values (p_empresa, l->>'conta_ref', l->>'anuncio_id', coalesce(l->>'variacao_id', ''), l->>'sku_vinculo', l->>'inventory_id', l->>'situacao',
      case when v_ok then (l->>'disponivel')::integer end, case when v_ok then (l->>'nao_disponivel')::integer end,
      case when v_ok then (l->>'total')::integer end, case when v_ok then l->'detalhe' end, l->>'erro', v_quando, p_usuario);
    insert into estoque_full_saldos as s (empresa_id, conta_ref, conta_nome, anuncio_id, variacao_id, sku_vinculo, inventory_id, situacao,
      disponivel, nao_disponivel, total, detalhe, erro, consultado_em, valido_disponivel, valido_nao_disponivel, valido_total, valido_em)
    values (p_empresa, l->>'conta_ref', l->>'conta_nome', l->>'anuncio_id', coalesce(l->>'variacao_id', ''), l->>'sku_vinculo', l->>'inventory_id', l->>'situacao',
      case when v_ok then (l->>'disponivel')::integer end, case when v_ok then (l->>'nao_disponivel')::integer end,
      case when v_ok then (l->>'total')::integer end, case when v_ok then l->'detalhe' end, l->>'erro', v_quando,
      case when v_ok then (l->>'disponivel')::integer end, case when v_ok then (l->>'nao_disponivel')::integer end,
      case when v_ok then (l->>'total')::integer end, case when v_ok then v_quando end)
    on conflict (empresa_id, conta_ref, anuncio_id, variacao_id) do update set
      conta_nome = excluded.conta_nome, sku_vinculo = excluded.sku_vinculo,
      inventory_id = coalesce(excluded.inventory_id, case when excluded.situacao = 'erro' then s.inventory_id end),
      situacao = excluded.situacao, disponivel = excluded.disponivel, nao_disponivel = excluded.nao_disponivel, total = excluded.total,
      detalhe = excluded.detalhe, erro = excluded.erro, consultado_em = excluded.consultado_em,
      -- último valor VÁLIDO: só muda com uma consulta bem-sucedida; 'sem_full' (anúncio sem inventory_id) limpa
      valido_disponivel = case when excluded.situacao = 'atualizado' then excluded.disponivel when excluded.situacao = 'sem_full' then null else s.valido_disponivel end,
      valido_nao_disponivel = case when excluded.situacao = 'atualizado' then excluded.nao_disponivel when excluded.situacao = 'sem_full' then null else s.valido_nao_disponivel end,
      valido_total = case when excluded.situacao = 'atualizado' then excluded.total when excluded.situacao = 'sem_full' then null else s.valido_total end,
      valido_em = case when excluded.situacao = 'atualizado' then excluded.consultado_em when excluded.situacao = 'sem_full' then null else s.valido_em end
    where s.consultado_em <= excluded.consultado_em;   -- consulta mais antiga chegando depois não sobrescreve a mais nova
    n := n + 1;
  end loop;
  return n;
end $$;

-- Data/hora do último movimento APLICADO de cada SKU (o que mudou o estoque normal do TMP10). Só leitura.
create or replace function public.estoque_saldo_normal_resumo(p_empresa uuid, p_skus text[])
returns table (sku text, ultimo_movimento_em timestamptz, ultima_origem text)
language sql stable set search_path = public as $$
  select distinct on (m.sku) m.sku, m.criado_em, m.origem
    from estoque_movimentos m
   where m.empresa_id = p_empresa and m.sku = any(p_skus) and m.aplicado
   order by m.sku, m.criado_em desc;
$$;

alter table public.estoque_full_saldos enable row level security;
alter table public.estoque_full_leituras enable row level security;
revoke all on public.estoque_full_saldos, public.estoque_full_leituras from public, anon, authenticated, service_role;
grant select on public.estoque_full_saldos, public.estoque_full_leituras to service_role;
revoke all on function public.estoque_full_imutavel() from public, anon, authenticated;
revoke all on function public.estoque_full_registrar(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.estoque_full_registrar(uuid, jsonb, uuid) to service_role;
revoke all on function public.estoque_saldo_normal_resumo(uuid, text[]) from public, anon, authenticated;
grant execute on function public.estoque_saldo_normal_resumo(uuid, text[]) to service_role;
commit;

-- PostgREST passa a enxergar as funções novas na hora (o Supabase normalmente já faz isso sozinho):
notify pgrst, 'reload schema';
