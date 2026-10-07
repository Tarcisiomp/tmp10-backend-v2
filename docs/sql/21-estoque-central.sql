-- TMP10 — Migração 21: ESTOQUE CENTRAL (movimentação oficial + fila de sincronização)
--
-- O QUE FAZ (nada é apagado; nenhum estoque é alterado ao rodar este arquivo)
--   1) Tabelas NOVAS:
--        estoque_movimentos  — toda alteração de estoque do TMP10 (venda, cancelamento, ajuste, aceite, cadastro)
--        estoque_sync_fila   — uma linha por anúncio/variação de destino (ML ou Shopee); junta alterações repetidas
--        estoque_sync_log    — cada tentativa de envio (resultado, status HTTP, resposta resumida)
--        estoque_sync_config — modo de envio por empresa: 'desligado' (padrão) | 'piloto' | 'ativo'
--   2) Colunas NOVAS (todas opcionais, com padrão; nenhuma coluna existente muda):
--        product_ml_links.sincronizar (padrão true), product_ml_links.ml_variation_id (vazio)
--        product_shopee_links.sincronizar (padrão true)
--        estoque_divergencias: plataforma, conta_ref, anuncio_id, variacao_id, chave, ocorrencias, atualizado_em,
--                              resolucao, resolvido_em, resolvido_por
--      As 218 mil divergências antigas NÃO são tocadas (continuam como estão, com chave vazia = "legado").
--   3) Funções (só o backend chama — chave de serviço):
--        estoque_movimentar            — altera o estoque e grava o movimento NA MESMA transação, com trava da linha
--                                        do produto e chave de idempotência (a mesma venda nunca baixa duas vezes)
--        estoque_fila_enfileirar / estoque_fila_reservar / estoque_fila_concluir — fila com junção (coalescência)
--        estoque_divergencia_registrar — UMA divergência aberta por anúncio (atualiza a contagem, não duplica)
--        estoque_anuncio_tem_full      — o anúncio teve venda Full/FBS (dados do próprio TMP10)? então não recebe envio
--   4) Gatilho em products: qualquer mudança de estoque_atual feita FORA da função oficial (tela antiga, SQL manual,
--      função antiga decrementar_estoque_central) é registrada em estoque_movimentos como 'alteracao_direta'.
--      Não bloqueia nada — só deixa rastro e marca para sincronizar.
--
-- SEGURANÇA
--   Tabelas novas: RLS ligado, sem policy e sem permissão para anon/authenticated (só o backend acessa).
--   Funções: execução só para service_role.
--
-- COMO APLICAR
--   Supabase → SQL Editor → cole o arquivo inteiro → Run. Pode rodar mais de uma vez (não duplica nada).
--   Depois rode 21-estoque-central-conferir.sql (só leitura). Para desfazer: 21-estoque-central-reverter.sql.

begin;

-- 1) Configuração do envio (sem linha = 'desligado': nada é enviado aos marketplaces) ------------------------
create table if not exists public.estoque_sync_config (
  empresa_id uuid primary key,
  modo text not null default 'desligado' check (modo in ('desligado','piloto','ativo')),
  skus_piloto text[] not null default '{}',
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid
);

-- 2) Movimentos oficiais --------------------------------------------------------------------------------------
create table if not exists public.estoque_movimentos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  sku text not null,
  produto_id uuid,
  estoque_anterior integer,
  estoque_novo integer,
  quantidade integer not null default 0,         -- estoque_novo - estoque_anterior (0 quando não aplicado)
  tipo text not null check (tipo in ('saida','entrada','definir','registro')),
  origem text not null,                          -- venda_mercadolivre, venda_shopee, cancelamento_*, ajuste_manual,
                                                 -- aceite_divergencia, cadastro_produto, alteracao_direta
  motivo text,
  referencia text,                               -- chave de idempotência (única por empresa)
  aplicado boolean not null default true,        -- false = registrado mas NÃO alterou (ex.: SKU não cadastrado)
  observacao text,
  usuario_id uuid,
  processo text,
  sincronizacao_pendente boolean not null default false, -- gatilho marca; o backend coloca na fila e desmarca
  criado_em timestamptz not null default now()
);
create unique index if not exists estoque_movimentos_referencia_uq on public.estoque_movimentos (empresa_id, referencia) where referencia is not null;
create index if not exists estoque_movimentos_sku_idx on public.estoque_movimentos (empresa_id, sku, criado_em desc);
create index if not exists estoque_movimentos_pendente_idx on public.estoque_movimentos (criado_em) where sincronizacao_pendente;

-- 3) Fila de sincronização (uma linha por destino; alterações seguidas só aumentam a "versao") ----------------
create table if not exists public.estoque_sync_fila (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null,
  sku text not null,
  destino text not null check (destino in ('mercadolivre','shopee')),
  conta_ref text not null,                       -- ML: ml_user_id da conta dona do anúncio · Shopee: shop_id
  anuncio_id text not null,                      -- ML: ml_item_id · Shopee: item_id
  variacao_id text not null default '',          -- Shopee: model_id ('' = produto sem variação)
  quantidade_alvo integer,
  quantidade_enviada integer,
  quantidade_confirmada integer,                 -- lida de volta na plataforma depois do envio
  status text not null default 'pendente'
    check (status in ('pendente','enviando','ok','erro_temporario','erro','bloqueado','simulado','pausado_loop')),
  versao integer not null default 1,
  versao_enviada integer,
  tentativas integer not null default 0,
  proxima_tentativa timestamptz not null default now(),
  ultimo_erro text,
  motivo text,
  movimento_id uuid,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  enviado_em timestamptz
);
create unique index if not exists estoque_sync_fila_destino_uq on public.estoque_sync_fila (empresa_id, destino, conta_ref, anuncio_id, variacao_id);
create index if not exists estoque_sync_fila_proxima_idx on public.estoque_sync_fila (proxima_tentativa) where status in ('pendente','erro_temporario','enviando');

-- 4) Registro de cada tentativa de envio ------------------------------------------------------------------------
create table if not exists public.estoque_sync_log (
  id uuid primary key default gen_random_uuid(),
  fila_id uuid,
  empresa_id uuid not null,
  sku text,
  destino text,
  conta_ref text,
  anuncio_id text,
  variacao_id text,
  versao integer,
  quantidade integer,
  resultado text not null,                       -- ok | erro | erro_temporario | simulado | bloqueado | pausado_loop
  http_status integer,
  resposta text,                                 -- resumo (no máximo 1000 caracteres), sem token
  criado_em timestamptz not null default now()
);
create index if not exists estoque_sync_log_fila_idx on public.estoque_sync_log (fila_id, criado_em desc);
create index if not exists estoque_sync_log_empresa_idx on public.estoque_sync_log (empresa_id, criado_em desc);

-- 5) Colunas novas nos vínculos (opcionais) -----------------------------------------------------------------------
alter table public.product_ml_links add column if not exists sincronizar boolean not null default true;
alter table public.product_ml_links add column if not exists ml_variation_id text;   -- PRECISA CONFIRMAR o contrato de variação do ML antes de usar
alter table public.product_shopee_links add column if not exists sincronizar boolean not null default true;

-- 6) Divergências: uma aberta por anúncio (as antigas ficam como estão, com chave vazia) -------------------------
alter table public.estoque_divergencias add column if not exists plataforma text;
alter table public.estoque_divergencias add column if not exists conta_ref text;
alter table public.estoque_divergencias add column if not exists anuncio_id text;
alter table public.estoque_divergencias add column if not exists variacao_id text;
alter table public.estoque_divergencias add column if not exists chave text;
alter table public.estoque_divergencias add column if not exists ocorrencias integer not null default 1;
alter table public.estoque_divergencias add column if not exists atualizado_em timestamptz;
alter table public.estoque_divergencias add column if not exists resolucao text;
alter table public.estoque_divergencias add column if not exists resolvido_em timestamptz;
alter table public.estoque_divergencias add column if not exists resolvido_por uuid;
create unique index if not exists estoque_divergencias_chave_aberta_uq
  on public.estoque_divergencias (empresa_id, chave) where chave is not null and resolvido is not true;

-- 7) Função oficial de movimentação ---------------------------------------------------------------------------------
--    p_tipo: 'saida' (tira p_quantidade) | 'entrada' (soma) | 'definir' (fica com p_quantidade)
--    p_esperado: se informado, só aplica se o estoque atual for exatamente esse (proteção contra edição simultânea)
--    Pode ficar NEGATIVO (venda real acima do estoque) — fica registrado e o backend avisa; o marketplace recebe 0.
create or replace function public.estoque_movimentar(
  p_empresa uuid, p_sku text, p_tipo text, p_quantidade integer, p_origem text,
  p_motivo text default null, p_referencia text default null, p_usuario uuid default null,
  p_processo text default null, p_esperado integer default null)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_qtd_produtos integer; v_prod record; v_ant integer; v_novo integer; v_mov uuid; v_exist record;
begin
  if p_empresa is null or coalesce(trim(p_sku), '') = '' then raise exception 'empresa e SKU são obrigatórios'; end if;
  if p_tipo not in ('saida','entrada','definir') then raise exception 'tipo inválido: %', p_tipo; end if;
  if p_quantidade is null or p_quantidade < 0 then raise exception 'quantidade inválida: %', p_quantidade; end if;
  if coalesce(trim(p_origem), '') = '' then raise exception 'origem é obrigatória'; end if;

  select count(*) into v_qtd_produtos from products where empresa_id = p_empresa and sku = p_sku;
  if v_qtd_produtos = 1 then
    -- trava a linha do produto: duas operações do mesmo SKU nunca se cruzam
    select id, estoque_atual into v_prod from products where empresa_id = p_empresa and sku = p_sku for update;
  end if;

  -- idempotência (conferida DEPOIS da trava: uma chamada concorrente com a mesma referência já está visível)
  if p_referencia is not null then
    select * into v_exist from estoque_movimentos where empresa_id = p_empresa and referencia = p_referencia;
    if found then
      return jsonb_build_object('ok', v_exist.aplicado, 'duplicado', true, 'aplicado', v_exist.aplicado,
        'anterior', v_exist.estoque_anterior, 'novo', v_exist.estoque_novo, 'movimento_id', v_exist.id,
        'erro', case when v_exist.aplicado then null else v_exist.observacao end);
    end if;
  end if;

  if v_qtd_produtos <> 1 then
    -- não altera nada, mas deixa rastro (ex.: venda de SKU que não está cadastrado no TMP10)
    insert into estoque_movimentos (empresa_id, sku, quantidade, tipo, origem, motivo, referencia, aplicado, observacao, usuario_id, processo)
    values (p_empresa, p_sku, 0, p_tipo, p_origem, p_motivo, p_referencia, false,
            case when v_qtd_produtos = 0 then 'produto_inexistente' else 'sku_duplicado' end, p_usuario, p_processo)
    returning id into v_mov;
    return jsonb_build_object('ok', false, 'aplicado', false, 'duplicado', false, 'movimento_id', v_mov,
      'erro', case when v_qtd_produtos = 0 then 'produto_inexistente' else 'sku_duplicado' end);
  end if;

  v_ant := coalesce(v_prod.estoque_atual, 0);
  if p_esperado is not null and v_ant <> p_esperado then
    return jsonb_build_object('ok', false, 'aplicado', false, 'duplicado', false, 'erro', 'estoque_mudou', 'anterior', v_ant);
  end if;
  v_novo := case p_tipo when 'saida' then v_ant - p_quantidade when 'entrada' then v_ant + p_quantidade else p_quantidade end;

  perform set_config('tmp10.estoque_movimento', '1', true);
  update products set estoque_atual = v_novo where id = v_prod.id;
  perform set_config('tmp10.estoque_movimento', '0', true);

  insert into estoque_movimentos (empresa_id, sku, produto_id, estoque_anterior, estoque_novo, quantidade, tipo, origem,
                                  motivo, referencia, aplicado, usuario_id, processo)
  values (p_empresa, p_sku, v_prod.id, v_prod.estoque_atual, v_novo, v_novo - v_ant, p_tipo, p_origem,
          p_motivo, p_referencia, true, p_usuario, p_processo)
  returning id into v_mov;

  return jsonb_build_object('ok', true, 'aplicado', true, 'duplicado', false, 'anterior', v_ant, 'novo', v_novo,
                            'movimento_id', v_mov, 'negativo', v_novo < 0);
exception when unique_violation then
  -- outra chamada gravou a mesma referência ao mesmo tempo: esta não altera nada
  select * into v_exist from estoque_movimentos where empresa_id = p_empresa and referencia = p_referencia;
  return jsonb_build_object('ok', coalesce(v_exist.aplicado, false), 'duplicado', true, 'aplicado', coalesce(v_exist.aplicado, false),
    'anterior', v_exist.estoque_anterior, 'novo', v_exist.estoque_novo, 'movimento_id', v_exist.id);
end $$;

-- 8) Fila ---------------------------------------------------------------------------------------------------------------
create or replace function public.estoque_fila_enfileirar(
  p_empresa uuid, p_sku text, p_destino text, p_conta_ref text, p_anuncio text, p_variacao text,
  p_motivo text default null, p_movimento uuid default null)
returns uuid language plpgsql set search_path = public as $$
declare v_id uuid;
begin
  insert into estoque_sync_fila as f (empresa_id, sku, destino, conta_ref, anuncio_id, variacao_id, motivo, movimento_id)
  values (p_empresa, p_sku, p_destino, p_conta_ref, p_anuncio, coalesce(p_variacao, ''), p_motivo, p_movimento)
  on conflict (empresa_id, destino, conta_ref, anuncio_id, variacao_id) do update set
    versao = f.versao + 1,
    sku = excluded.sku,
    motivo = excluded.motivo,
    movimento_id = coalesce(excluded.movimento_id, f.movimento_id),
    -- 'enviando' continua (a versão nova faz reenviar ao terminar); 'pausado_loop' só sai com liberação manual
    status = case when f.status in ('enviando','pausado_loop') then f.status else 'pendente' end,
    tentativas = case when f.status in ('enviando','pausado_loop') then f.tentativas else 0 end,
    proxima_tentativa = case when f.status in ('enviando','pausado_loop') then f.proxima_tentativa else now() end,
    ultimo_erro = case when f.status in ('enviando','pausado_loop') then f.ultimo_erro else null end,
    atualizado_em = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.estoque_fila_reservar(p_limite integer default 20)
returns setof public.estoque_sync_fila language sql set search_path = public as $$
  update estoque_sync_fila f set status = 'enviando', atualizado_em = now(), tentativas = f.tentativas + 1
   where f.id in (
     select id from estoque_sync_fila
      where (status in ('pendente','erro_temporario') and proxima_tentativa <= now())
         or (status = 'enviando' and atualizado_em < now() - interval '10 minutes')   -- envio interrompido
      order by proxima_tentativa
      limit greatest(1, least(coalesce(p_limite, 20), 200))
      for update skip locked)
  returning f.*;
$$;

-- Se a versão mudou durante o envio (estoque mudou de novo), volta para 'pendente' e manda o número novo.
create or replace function public.estoque_fila_concluir(
  p_id uuid, p_versao integer, p_status text, p_alvo integer, p_enviada integer, p_confirmada integer,
  p_erro text, p_atraso_segundos integer default 0)
returns text language plpgsql set search_path = public as $$
declare v_status text;
begin
  if p_status not in ('ok','erro_temporario','erro','bloqueado','simulado','pausado_loop') then
    raise exception 'status inválido: %', p_status;
  end if;
  update estoque_sync_fila f set
    status = case when f.versao <> p_versao and p_status <> 'pausado_loop' then 'pendente' else p_status end,
    quantidade_alvo = p_alvo,
    quantidade_enviada = case when p_enviada is not null then p_enviada else f.quantidade_enviada end,
    quantidade_confirmada = case when p_enviada is not null then p_confirmada else f.quantidade_confirmada end,
    versao_enviada = case when p_enviada is not null then p_versao else f.versao_enviada end,
    enviado_em = case when p_enviada is not null then now() else f.enviado_em end,
    ultimo_erro = left(p_erro, 1000),
    tentativas = case when f.versao <> p_versao then 0 else f.tentativas end,
    proxima_tentativa = case when f.versao <> p_versao then now() else now() + make_interval(secs => greatest(coalesce(p_atraso_segundos, 0), 0)) end,
    atualizado_em = now()
  where f.id = p_id
  returning status into v_status;
  return v_status;
end $$;

-- 9) Divergência: UMA aberta por anúncio/variação (não grava de novo a cada conferência) ------------------------------
create or replace function public.estoque_divergencia_registrar(
  p_empresa uuid, p_sku text, p_chave text, p_plataforma text, p_conta text, p_anuncio text, p_variacao text,
  p_tmp10 integer, p_plataforma_qtd integer)
returns jsonb language plpgsql set search_path = public as $$
declare v_id uuid; v_oc integer;
begin
  if p_tmp10 = p_plataforma_qtd then
    update estoque_divergencias set resolvido = true, resolucao = 'igualou', resolvido_em = now(), atualizado_em = now()
     where empresa_id = p_empresa and chave = p_chave and resolvido is not true;
    return jsonb_build_object('situacao', 'igual');
  end if;
  update estoque_divergencias set sku = p_sku, estoque_tmp10 = p_tmp10, estoque_ml = p_plataforma_qtd,
         diferenca = p_plataforma_qtd - p_tmp10, ocorrencias = ocorrencias + 1, atualizado_em = now()
   where empresa_id = p_empresa and chave = p_chave and resolvido is not true
  returning id, ocorrencias into v_id, v_oc;
  if v_id is null then
    begin
      insert into estoque_divergencias (empresa_id, sku, estoque_tmp10, estoque_ml, diferenca, detectado_em, resolvido,
                                        plataforma, conta_ref, anuncio_id, variacao_id, chave, ocorrencias, atualizado_em)
      values (p_empresa, p_sku, p_tmp10, p_plataforma_qtd, p_plataforma_qtd - p_tmp10, now(), false,
              p_plataforma, p_conta, p_anuncio, coalesce(p_variacao, ''), p_chave, 1, now())
      returning id, ocorrencias into v_id, v_oc;
    exception when unique_violation then
      update estoque_divergencias set ocorrencias = ocorrencias + 1, atualizado_em = now()
       where empresa_id = p_empresa and chave = p_chave and resolvido is not true
      returning id, ocorrencias into v_id, v_oc;
    end;
  end if;
  return jsonb_build_object('situacao', 'diferente', 'id', v_id, 'ocorrencias', v_oc);
end $$;

-- 10) O anúncio teve venda Full (ML) ou FBS (Shopee) — pelos pedidos já gravados no TMP10 ----------------------------
create or replace function public.estoque_anuncio_tem_full(p_empresa uuid, p_anuncio text, p_dias integer default 90)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from ml_orders o
      cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) e
     where o.empresa_id = p_empresa and o.is_fulfillment is true
       and o.created_at_ml >= now() - make_interval(days => greatest(coalesce(p_dias, 90), 1))
       and e->>'ml_item_id' = p_anuncio);
$$;

-- 11) Rastro de qualquer alteração de estoque feita fora da função oficial -------------------------------------------
create or replace function public.estoque_registrar_alteracao_direta()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('tmp10.estoque_movimento', true), '0') = '1' then return null; end if;
  if new.empresa_id is null or new.sku is null then return null; end if;
  if tg_op = 'UPDATE' and new.estoque_atual is not distinct from old.estoque_atual then return null; end if;
  if tg_op = 'INSERT' and new.estoque_atual is null then return null; end if;
  insert into estoque_movimentos (empresa_id, sku, produto_id, estoque_anterior, estoque_novo, quantidade, tipo, origem,
                                  motivo, aplicado, usuario_id, processo, sincronizacao_pendente)
  values (new.empresa_id, new.sku, new.id,
          case when tg_op = 'UPDATE' then old.estoque_atual end, new.estoque_atual,
          coalesce(new.estoque_atual, 0) - coalesce(case when tg_op = 'UPDATE' then old.estoque_atual end, 0),
          'registro', case when tg_op = 'INSERT' then 'cadastro_produto' else 'alteracao_direta' end,
          'Alteração feita fora da função oficial (registrada automaticamente)', true,
          auth.uid(), coalesce(nullif(current_setting('role', true), 'none'), session_user::text), true);
  return null;
end $$;

drop trigger if exists estoque_rastro_alteracao on public.products;
create trigger estoque_rastro_alteracao
  after insert or update of estoque_atual on public.products
  for each row execute function public.estoque_registrar_alteracao_direta();

-- 12) Segurança ------------------------------------------------------------------------------------------------------------
alter table public.estoque_movimentos enable row level security;
alter table public.estoque_sync_fila enable row level security;
alter table public.estoque_sync_log enable row level security;
alter table public.estoque_sync_config enable row level security;
revoke all on public.estoque_movimentos, public.estoque_sync_fila, public.estoque_sync_log, public.estoque_sync_config from anon, authenticated;
grant select, insert, update, delete on public.estoque_movimentos, public.estoque_sync_fila, public.estoque_sync_log, public.estoque_sync_config to service_role;

revoke all on function public.estoque_movimentar(uuid, text, text, integer, text, text, text, uuid, text, integer) from public, anon, authenticated;
revoke all on function public.estoque_fila_enfileirar(uuid, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.estoque_fila_reservar(integer) from public, anon, authenticated;
revoke all on function public.estoque_fila_concluir(uuid, integer, text, integer, integer, integer, text, integer) from public, anon, authenticated;
revoke all on function public.estoque_divergencia_registrar(uuid, text, text, text, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.estoque_anuncio_tem_full(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.estoque_registrar_alteracao_direta() from public, anon, authenticated;
grant execute on function public.estoque_movimentar(uuid, text, text, integer, text, text, text, uuid, text, integer) to service_role;
grant execute on function public.estoque_fila_enfileirar(uuid, text, text, text, text, text, text, uuid) to service_role;
grant execute on function public.estoque_fila_reservar(integer) to service_role;
grant execute on function public.estoque_fila_concluir(uuid, integer, text, integer, integer, integer, text, integer) to service_role;
grant execute on function public.estoque_divergencia_registrar(uuid, text, text, text, text, text, text, integer, integer) to service_role;
grant execute on function public.estoque_anuncio_tem_full(uuid, text, integer) to service_role;

commit;
