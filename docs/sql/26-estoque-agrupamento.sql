-- TMP10 — Migração 26: AGRUPAR ANÚNCIOS POR PRODUTO PRINCIPAL (decisão MANUAL do administrador)
--
-- O QUE FAZ (só ACRESCENTA; não apaga, não altera e não move nenhuma linha existente):
--   • estoque_agrupamento         — uma linha por anúncio agrupado: anúncio (plataforma, conta, ID, variação) + SKU ORIGINAL
--                                   → produto principal. Os vínculos (product_ml_links / product_shopee_links), os produtos e os
--                                   SKUs dos anúncios NÃO mudam: o agrupamento é uma camada por cima deles.
--   • estoque_agrupamento_eventos — auditoria IMUTÁVEL de cada operação (quem, quando, o que entrou/saiu, alertas, saldos).
--   • estoque_agrupamento_aplicar — UMA função atômica para agrupar, editar e desfazer (tudo ou nada; trava por empresa;
--                                   idempotente pela operacao_id).
--
-- REGRAS GARANTIDAS PELO BANCO:
--   • um anúncio/variação só pode estar ATIVO em um agrupamento (índice único parcial);
--   • o mesmo (anúncio + SKU original) também é único — é a chave usada para achar o principal de uma venda;
--   • desfazer NÃO apaga: só marca ativo=false com quem/quando (histórico preservado);
--   • nenhuma outra coluna pode ser alterada; DELETE e TRUNCATE são recusados (até para o dono);
--   • RLS ligado sem policy: o navegador não tem acesso; o backend (service_role) só LÊ e chama a função.
--
-- O ESTOQUE NÃO É ALTERADO AQUI. Nenhum saldo é somado, zerado ou copiado.
--
-- COMO APLICAR: Supabase → SQL Editor → cole o arquivo inteiro → Run. Pode rodar mais de uma vez.
-- PARA DESFAZER: 26-estoque-agrupamento-reverter.sql (ATENÇÃO: apaga o histórico de agrupamentos).

begin;
set local lock_timeout = '10s';

create table if not exists public.estoque_agrupamento (
  id bigint generated always as identity primary key,
  empresa_id uuid not null,
  produto_sku text not null,                 -- SKU do produto PRINCIPAL (fonte única do estoque físico)
  plataforma text not null check (plataforma in ('mercadolivre', 'shopee')),
  conta_ref text not null,                   -- ML: ml_user_id (ou nick:<apelido>) · Shopee: shop_id — mesmo formato da fila
  conta_nome text,
  anuncio_id text not null,                  -- ML: ml_item_id · Shopee: item_id
  variacao_id text not null default '',      -- Shopee: model_id ('' = item sem variação)
  sku_original text not null,                -- SKU do vínculo/anúncio (o que chega nos pedidos) — NUNCA é alterado
  ativo boolean not null default true,
  operacao_id uuid not null,
  criado_por uuid,
  criado_em timestamptz not null default now(),
  desfeito_operacao uuid,
  desfeito_por uuid,
  desfeito_em timestamptz,
  check (sku_original <> produto_sku)
);
create unique index if not exists estoque_agrupamento_anuncio_ativo_uq on public.estoque_agrupamento (empresa_id, plataforma, anuncio_id, variacao_id) where ativo;
create unique index if not exists estoque_agrupamento_anuncio_sku_ativo_uq on public.estoque_agrupamento (empresa_id, plataforma, anuncio_id, sku_original) where ativo;
create index if not exists estoque_agrupamento_produto_idx on public.estoque_agrupamento (empresa_id, produto_sku) where ativo;
create index if not exists estoque_agrupamento_original_idx on public.estoque_agrupamento (empresa_id, sku_original) where ativo;

create table if not exists public.estoque_agrupamento_eventos (
  id bigint generated always as identity primary key,
  empresa_id uuid not null,
  operacao_id uuid not null,
  acao text not null check (acao in ('agrupar', 'editar', 'desfazer')),
  produto_sku text not null,
  usuario_id uuid,
  adicionados integer not null default 0,
  removidos integer not null default 0,
  detalhe jsonb,                             -- anúncios, SKUs originais, saldos congelados, alertas mostrados na prévia
  criado_em timestamptz not null default now()
);
create unique index if not exists estoque_agrupamento_eventos_operacao_uq on public.estoque_agrupamento_eventos (empresa_id, operacao_id);
create index if not exists estoque_agrupamento_eventos_produto_idx on public.estoque_agrupamento_eventos (empresa_id, produto_sku, criado_em desc);

-- Imutabilidade: DELETE/TRUNCATE nunca; UPDATE só para DESATIVAR (ativo true → false + quem/quando/operação)
create or replace function public.estoque_agrupamento_protegido()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and tg_table_name = 'estoque_agrupamento'
     and old.ativo = true and new.ativo = false
     and new.desfeito_operacao is not null and new.desfeito_em is not null
     and (new.id, new.empresa_id, new.produto_sku, new.plataforma, new.conta_ref, new.conta_nome, new.anuncio_id, new.variacao_id,
          new.sku_original, new.operacao_id, new.criado_por, new.criado_em)
         is not distinct from
         (old.id, old.empresa_id, old.produto_sku, old.plataforma, old.conta_ref, old.conta_nome, old.anuncio_id, old.variacao_id,
          old.sku_original, old.operacao_id, old.criado_por, old.criado_em)
  then
    return new;
  end if;
  raise exception 'estoque_agrupamento: histórico imutável (%) — desfazer só desativa a linha', tg_op using errcode = '42501';
end $$;

drop trigger if exists estoque_agrupamento_protegido on public.estoque_agrupamento;
create trigger estoque_agrupamento_protegido before update or delete on public.estoque_agrupamento
  for each row execute function public.estoque_agrupamento_protegido();
drop trigger if exists estoque_agrupamento_sem_truncate on public.estoque_agrupamento;
create trigger estoque_agrupamento_sem_truncate before truncate on public.estoque_agrupamento
  for each statement execute function public.estoque_agrupamento_protegido();
drop trigger if exists estoque_agrupamento_eventos_protegido on public.estoque_agrupamento_eventos;
create trigger estoque_agrupamento_eventos_protegido before update or delete on public.estoque_agrupamento_eventos
  for each row execute function public.estoque_agrupamento_protegido();
drop trigger if exists estoque_agrupamento_eventos_sem_truncate on public.estoque_agrupamento_eventos;
create trigger estoque_agrupamento_eventos_sem_truncate before truncate on public.estoque_agrupamento_eventos
  for each statement execute function public.estoque_agrupamento_protegido();

-- Agrupar / editar / desfazer numa transação só. p_adicionar = [{plataforma, conta_ref, conta_nome, anuncio_id, variacao_id, sku_original}]
-- p_remover = ids ativos DESTE principal. Qualquer conflito (anúncio já agrupado, id de outro principal...) desfaz tudo.
create or replace function public.estoque_agrupamento_aplicar(
  p_empresa uuid, p_operacao uuid, p_produto text, p_usuario uuid, p_acao text,
  p_adicionar jsonb, p_remover bigint[], p_detalhe jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_add integer := 0; v_rem integer := 0; v_esperado integer := coalesce(array_length(p_remover, 1), 0);
  a jsonb;
begin
  if p_empresa is null or p_operacao is null or coalesce(trim(p_produto), '') = '' then
    raise exception 'agrupamento: empresa, operação e produto são obrigatórios' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('estoque_agrupamento:' || p_empresa::text));
  if exists (select 1 from estoque_agrupamento_eventos where empresa_id = p_empresa and operacao_id = p_operacao) then
    return jsonb_build_object('ok', true, 'duplicado', true);
  end if;
  if v_esperado > 0 then
    update estoque_agrupamento set ativo = false, desfeito_operacao = p_operacao, desfeito_por = p_usuario, desfeito_em = now()
     where empresa_id = p_empresa and produto_sku = p_produto and ativo and id = any(p_remover);
    get diagnostics v_rem = row_count;
    if v_rem <> v_esperado then
      raise exception 'agrupamento: % de % anúncio(s) a remover não pertencem (mais) a este produto principal', v_esperado - v_rem, v_esperado using errcode = '40001';
    end if;
  end if;
  for a in select * from jsonb_array_elements(coalesce(p_adicionar, '[]'::jsonb)) loop
    insert into estoque_agrupamento (empresa_id, produto_sku, plataforma, conta_ref, conta_nome, anuncio_id, variacao_id, sku_original, operacao_id, criado_por)
    values (p_empresa, p_produto, a->>'plataforma', a->>'conta_ref', a->>'conta_nome', a->>'anuncio_id', coalesce(a->>'variacao_id', ''), a->>'sku_original', p_operacao, p_usuario);
    v_add := v_add + 1;
  end loop;
  insert into estoque_agrupamento_eventos (empresa_id, operacao_id, acao, produto_sku, usuario_id, adicionados, removidos, detalhe)
  values (p_empresa, p_operacao, p_acao, p_produto, p_usuario, v_add, v_rem, p_detalhe);
  return jsonb_build_object('ok', true, 'duplicado', false, 'adicionados', v_add, 'removidos', v_rem);
exception when unique_violation then
  raise exception 'agrupamento: um dos anúncios já está ativo em outro agrupamento — nada foi gravado' using errcode = '23505';
end $$;

alter table public.estoque_agrupamento enable row level security;
alter table public.estoque_agrupamento_eventos enable row level security;
revoke all on public.estoque_agrupamento, public.estoque_agrupamento_eventos from public, anon, authenticated, service_role;
grant select on public.estoque_agrupamento, public.estoque_agrupamento_eventos to service_role;
revoke all on function public.estoque_agrupamento_protegido() from public, anon, authenticated;
revoke all on function public.estoque_agrupamento_aplicar(uuid, uuid, text, uuid, text, jsonb, bigint[], jsonb) from public, anon, authenticated;
grant execute on function public.estoque_agrupamento_aplicar(uuid, uuid, text, uuid, text, jsonb, bigint[], jsonb) to service_role;
commit;

-- Conferência (deve listar as 2 tabelas e a função):
select table_name from information_schema.tables where table_schema = 'public' and table_name like 'estoque_agrupamento%' order by 1;
select proname from pg_proc where proname = 'estoque_agrupamento_aplicar';
