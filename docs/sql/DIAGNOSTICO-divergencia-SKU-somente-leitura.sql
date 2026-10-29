-- TMP10 — DIAGNÓSTICO da divergência que bloqueia a prévia (SOMENTE LEITURA; não altera nada).
-- Supabase → SQL Editor → troque o SKU na linha "sku_alvo" se precisar → Run. Mostra UMA tabela com tudo o que importa.
with alvo as (select '1Tela10cmPreto'::text as sku_alvo),
div as (
  select d.id, d.empresa_id, d.sku, d.plataforma, d.conta_ref, d.anuncio_id, d.variacao_id, d.estoque_tmp10, d.estoque_ml, d.diferenca, d.ocorrencias,
         d.detectado_em, d.atualizado_em, d.resolvido
    from public.estoque_divergencias d, alvo where d.sku = alvo.sku_alvo and d.chave is not null and d.resolvido is not true)
select 'A) divergência aberta' as bloco, div.id::text as id, div.plataforma || ' ' || coalesce(div.conta_ref, '?') || ' ' || coalesce(div.anuncio_id, '?') as anuncio,
       'TMP10 ' || coalesce(div.estoque_tmp10::text, '—') || ' × plataforma ' || coalesce(div.estoque_ml::text, '—') || ' (' || div.ocorrencias || ' conferência(s))' as valores,
       'detectada ' || to_char(div.detectado_em, 'DD/MM/YYYY HH24:MI') || coalesce(' · última ' || to_char(div.atualizado_em, 'DD/MM/YYYY HH24:MI'), '') as quando
  from div
union all
select 'B) estoque normal ATUAL do produto', p.id::text, p.sku, 'estoque_atual = ' || coalesce(p.estoque_atual::text, 'NULO'), 'empresa ' || p.empresa_id
  from public.products p, alvo where p.sku = alvo.sku_alvo
union all
select 'C) vínculo ML do SKU', l.ml_item_id, l.account_nickname || ' (ml_user_id ' || coalesce(l.ml_user_id::text, '?') || ')',
       'sincronizar = ' || coalesce(l.sincronizar::text, 'nulo') || coalesce(' · variação ' || l.ml_variation_id, ''), 'quantity gravada no vínculo = ' || coalesce(l.quantity::text, '—')
  from public.product_ml_links l, alvo where l.sku = alvo.sku_alvo
union all
select 'D) vendas FULL no histórico (90 dias)', e->>'ml_item_id', count(*)::text || ' pedido(s) Full', 'último em ' || to_char(max(o.created_at_ml), 'DD/MM/YYYY'), 'se houver: o anúncio é Full e o número do ML é o estoque Full'
  from public.ml_orders o cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) e, alvo
 where o.is_fulfillment is true and o.created_at_ml >= now() - interval '90 days' and e->>'sku' = alvo.sku_alvo
 group by e->>'ml_item_id'
union all
select 'E) últimos movimentos do estoque normal', m.id::text, m.origem || coalesce(' · ' || m.referencia, ''),
       coalesce(m.estoque_anterior::text, '—') || ' → ' || coalesce(m.estoque_novo::text, '—') || case when m.aplicado then '' else ' (NÃO aplicado)' end, to_char(m.criado_em, 'DD/MM/YYYY HH24:MI')
  from (select * from public.estoque_movimentos, alvo where sku = alvo.sku_alvo order by criado_em desc limit 10) m
union all
select 'F) fila de envio do anúncio', f.anuncio_id, f.status, 'alvo ' || coalesce(f.quantidade_alvo::text, '—') || ' · enviado ' || coalesce(f.quantidade_enviada::text, '—') || ' · lido ' || coalesce(f.quantidade_confirmada::text, '—'),
       coalesce(left(f.ultimo_erro, 160), '')
  from public.estoque_sync_fila f, alvo where f.sku = alvo.sku_alvo
order by 1, 2;

-- COMO LER
--   • Se o anúncio de A aparece em D (vendas Full) ou a prévia diz "anúncio FULL (inventory …)": a divergência comparou o estoque
--     Full do ML com o estoque normal (conferência antiga). NÃO use "Aceitar" (copiaria o Full para o normal). Use "Ignorar".
--   • Se NÃO é Full: é diferença real entre o TMP10 (B) e o anúncio. Decida no painel do Estoque:
--       "Enviar número do TMP10" (o anúncio passa a mostrar B) · "Aceitar" (B passa a ser o número da plataforma) · "Ignorar".
--   Nada aqui altera dados; a decisão é sua, pelo painel.
