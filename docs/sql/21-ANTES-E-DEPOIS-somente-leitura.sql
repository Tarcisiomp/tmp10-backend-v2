-- TMP10 — FOTO DO ESTOQUE (SOMENTE LEITURA). Rode ANTES e DEPOIS da migração 21 e compare: as linhas devem ser IGUAIS.
-- Prova que a migração não alterou nenhum estoque nem apagou divergência.
select 'produtos' as item, count(*)::text as valor from public.products
union all select 'soma do estoque_atual', coalesce(sum(estoque_atual), 0)::text from public.products
union all select 'impressão digital do estoque (id:estoque)', md5(coalesce(string_agg(id::text || ':' || coalesce(estoque_atual::text, 'nulo'), ',' order by id), '')) from public.products
union all select 'divergências (total)', count(*)::text from public.estoque_divergencias
union all select 'divergências abertas', count(*)::text from public.estoque_divergencias where resolvido is not true
union all select 'vínculos ML', count(*)::text from public.product_ml_links
union all select 'vínculos Shopee', count(*)::text from public.product_shopee_links;
