-- TMP10 — Migração 22: fila do Estoque Central em LOTE (botão "Sincronizar Estoque Agora")
--
-- O QUE FAZ
--   Cria DUAS funções novas (só leitura/fila): estoque_fila_enfileirar_lote e estoque_anuncios_full. Não cria tabela, não altera coluna, não toca em estoque,
--   em divergência, em vínculo nem na fila existente. Só o backend executa (chave de serviço).
--
--   Antes: o botão gravava a fila anúncio por anúncio (198 SKUs ≈ 673 chamadas ≈ 4–5 minutos).
--   Agora: os anúncios de TODOS os SKUs escolhidos entram na fila numa única operação no banco, com a MESMA regra
--   da função de um anúncio (estoque_fila_enfileirar, migração 21):
--     · uma linha por anúncio/variação (índice único da fila) — repetir não duplica, só sobe a "versão";
--     · item 'enviando' continua (a versão nova faz reenviar ao terminar); 'pausado_loop' só sai com liberação manual;
--     · o mesmo anúncio ligado a dois SKUs entra UMA vez (fica com o primeiro SKU em ordem alfabética).
--   Os vínculos usados são os mesmos de antes: ML (ml_item_id preenchido) e Shopee (item_id e shop_id preenchidos).
--   Envio, Full, conta da empresa, simulação: continuam sendo decididos no processamento (backend), como hoje.
--
-- COMO APLICAR: Supabase → SQL Editor → cole o arquivo inteiro → Run. Pode rodar mais de uma vez.
-- PARA DESFAZER: 22-estoque-fila-lote-reverter.sql (apaga só estas 2 funções; o backend volta a gravar um a um).

begin;

create or replace function public.estoque_fila_enfileirar_lote(p_empresa uuid, p_skus text[], p_motivo text default null)
returns jsonb language plpgsql set search_path = public as $$
declare v_destinos integer; v_skus integer;
begin
  if p_empresa is null then raise exception 'empresa é obrigatória'; end if;
  if p_skus is null or coalesce(array_length(p_skus, 1), 0) = 0 then
    return jsonb_build_object('destinos', 0, 'skus_com_anuncio', 0);
  end if;
  if array_length(p_skus, 1) > 500 then raise exception 'no máximo 500 SKUs por vez'; end if;

  with destinos as (
    select distinct on (destino, conta_ref, anuncio_id, variacao_id) sku, destino, conta_ref, anuncio_id, variacao_id
      from (
        select l.sku, 'mercadolivre'::text as destino,
               coalesce(nullif(l.ml_user_id, ''), 'nick:' || l.account_nickname) as conta_ref,
               l.ml_item_id::text as anuncio_id, ''::text as variacao_id
          from product_ml_links l
         where l.empresa_id = p_empresa and l.sku = any(p_skus) and l.ml_item_id is not null
        union all
        select s.sku, 'shopee', s.shop_id::text, s.item_id::text, coalesce(s.model_id::text, '')
          from product_shopee_links s
         where s.empresa_id = p_empresa and s.sku = any(p_skus) and s.item_id is not null and s.shop_id is not null
      ) x
     order by destino, conta_ref, anuncio_id, variacao_id, sku
  ), gravados as (
    insert into estoque_sync_fila as f (empresa_id, sku, destino, conta_ref, anuncio_id, variacao_id, motivo)
    select p_empresa, d.sku, d.destino, d.conta_ref, d.anuncio_id, d.variacao_id, left(p_motivo, 200) from destinos d
    on conflict (empresa_id, destino, conta_ref, anuncio_id, variacao_id) do update set
      versao = f.versao + 1,
      sku = excluded.sku,
      motivo = excluded.motivo,
      status = case when f.status in ('enviando','pausado_loop') then f.status else 'pendente' end,
      tentativas = case when f.status in ('enviando','pausado_loop') then f.tentativas else 0 end,
      proxima_tentativa = case when f.status in ('enviando','pausado_loop') then f.proxima_tentativa else now() end,
      ultimo_erro = case when f.status in ('enviando','pausado_loop') then f.ultimo_erro else null end,
      atualizado_em = now()
    returning f.sku
  )
  select count(*), count(distinct sku) into v_destinos, v_skus from gravados;
  return jsonb_build_object('destinos', v_destinos, 'skus_com_anuncio', v_skus);
end $$;

-- Anúncios com venda Full (ML) / FBS (Shopee) nos últimos N dias — a MESMA regra de estoque_anuncio_tem_full (21),
-- de uma vez só, para a prévia mostrar quantos anúncios ficarão bloqueados. Só lê.
create or replace function public.estoque_anuncios_full(p_empresa uuid, p_dias integer default 90)
returns setof text language sql stable set search_path = public as $$
  select distinct e->>'ml_item_id'
    from ml_orders o
    cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) e
   where o.empresa_id = p_empresa and o.is_fulfillment is true
     and o.created_at_ml >= now() - make_interval(days => greatest(coalesce(p_dias, 90), 1))
     and e->>'ml_item_id' is not null;
$$;

revoke all on function public.estoque_anuncios_full(uuid, integer) from public, anon, authenticated;
grant execute on function public.estoque_anuncios_full(uuid, integer) to service_role;
revoke all on function public.estoque_fila_enfileirar_lote(uuid, text[], text) from public, anon, authenticated;
grant execute on function public.estoque_fila_enfileirar_lote(uuid, text[], text) to service_role;

commit;

-- CONFERÊNCIA (só leitura): deve mostrar 2 linhas, navegador_executa = false
-- select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as navegador_executa
--   from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('estoque_fila_enfileirar_lote', 'estoque_anuncios_full');
