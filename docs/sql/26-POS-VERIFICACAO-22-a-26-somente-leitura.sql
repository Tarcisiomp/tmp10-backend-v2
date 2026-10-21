-- TMP10 — PÓS-VERIFICAÇÃO (SOMENTE LEITURA) depois das migrações 22 a 26. Não altera nada.
-- Supabase → SQL Editor → cole TUDO → Run. Esperado: TODAS as linhas dos grupos 1 e 2 com situacao = 'OK'.
-- Grupo 3 (fotografia): compare com a pré-verificação. As migrações NÃO mexem em dados; se algum número mudou, o
-- grupo 3 também lista os movimentos dos últimos 60 minutos por origem (vendas reais que chegaram no meio explicam a diferença).
with
obj(o, mig, item, ok) as (values
  (1, '22', 'função estoque_fila_enfileirar_lote', exists (select 1 from pg_proc where proname = 'estoque_fila_enfileirar_lote' and pg_get_function_identity_arguments(oid) = 'p_empresa uuid, p_skus text[], p_motivo text')),
  (2, '22', 'função estoque_anuncios_full', exists (select 1 from pg_proc where proname = 'estoque_anuncios_full' and pg_get_function_identity_arguments(oid) = 'p_empresa uuid, p_dias integer')),
  (3, '23', 'índice estoque_divergencias_painel_idx', exists (select 1 from pg_indexes where indexname = 'estoque_divergencias_painel_idx')),
  (4, '23', 'índice estoque_divergencias_legado_idx', exists (select 1 from pg_indexes where indexname = 'estoque_divergencias_legado_idx')),
  (5, '24', 'tabelas execucoes / eventos / trava', to_regclass('public.estoque_ajuste_massa_execucoes') is not null and to_regclass('public.estoque_ajuste_massa_eventos') is not null and to_regclass('public.estoque_ajuste_massa_trava') is not null),
  (6, '24', 'funções travar / renovar / liberar', (select count(*) from pg_proc where proname in ('estoque_ajuste_massa_travar','estoque_ajuste_massa_renovar','estoque_ajuste_massa_liberar')) = 3),
  (7, '24', 'gatilhos de imutabilidade (4)', (select count(*) from pg_trigger where tgname in ('estoque_ajuste_massa_execucoes_imutavel','estoque_ajuste_massa_execucoes_sem_truncate','estoque_ajuste_massa_eventos_imutavel','estoque_ajuste_massa_eventos_sem_truncate')) = 4),
  (8, '24', 'RLS ligado nas 3 tabelas', (select bool_and(relrowsecurity) from pg_class where oid in ('public.estoque_ajuste_massa_execucoes'::regclass, 'public.estoque_ajuste_massa_eventos'::regclass, 'public.estoque_ajuste_massa_trava'::regclass))),
  (9, '24', 'backend: só SELECT/INSERT na auditoria', (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'estoque_ajuste_massa_eventos' and grantee = 'service_role') = 'INSERT,SELECT'),
  (10, '25', 'regra plataforma mercadolivre/shopee/multi (1 regra só)', (select count(*) from pg_constraint where conrelid = 'public.estoque_ajuste_massa_execucoes'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%plataforma%') = 1
      and exists (select 1 from pg_constraint where conname = 'estoque_ajuste_massa_execucoes_plataforma_check' and pg_get_constraintdef(oid) ilike '%multi%')),
  (11, '26', 'tabelas estoque_agrupamento / _eventos', to_regclass('public.estoque_agrupamento') is not null and to_regclass('public.estoque_agrupamento_eventos') is not null),
  (12, '26', 'função estoque_agrupamento_aplicar (security definer)', exists (select 1 from pg_proc where proname = 'estoque_agrupamento_aplicar' and prosecdef and pg_get_function_identity_arguments(oid) = 'p_empresa uuid, p_operacao uuid, p_produto text, p_usuario uuid, p_acao text, p_adicionar jsonb, p_remover bigint[], p_detalhe jsonb')),
  (13, '26', 'índices únicos (anúncio ativo; anúncio+SKU ativo; operação)', (select count(*) from pg_indexes where indexname in ('estoque_agrupamento_anuncio_ativo_uq','estoque_agrupamento_anuncio_sku_ativo_uq','estoque_agrupamento_eventos_operacao_uq')) = 3),
  (14, '26', 'gatilhos de proteção (4)', (select count(*) from pg_trigger where tgname in ('estoque_agrupamento_protegido','estoque_agrupamento_sem_truncate','estoque_agrupamento_eventos_protegido','estoque_agrupamento_eventos_sem_truncate')) = 4),
  (15, '26', 'RLS ligado nas 2 tabelas', (select bool_and(relrowsecurity) from pg_class where oid in ('public.estoque_agrupamento'::regclass, 'public.estoque_agrupamento_eventos'::regclass))),
  (16, '26', 'backend: só SELECT nas tabelas (grava só pela função)', (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'estoque_agrupamento' and grantee = 'service_role') = 'SELECT'),
  (17, '24/26', 'navegador (anon/authenticated) sem acesso às tabelas novas', not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and (table_name like 'estoque_ajuste_massa%' or table_name like 'estoque_agrupamento%') and grantee in ('anon','authenticated'))),
  (18, '22/24/26', 'navegador não executa as funções novas', not exists (select 1 from pg_proc p where p.proname in ('estoque_fila_enfileirar_lote','estoque_anuncios_full','estoque_ajuste_massa_travar','estoque_ajuste_massa_renovar','estoque_ajuste_massa_liberar','estoque_agrupamento_aplicar')
      and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))),
  (19, '22/24/26', 'backend executa as funções novas', (select bool_and(has_function_privilege('service_role', p.oid, 'execute')) from pg_proc p where p.proname in ('estoque_fila_enfileirar_lote','estoque_anuncios_full','estoque_ajuste_massa_travar','estoque_ajuste_massa_renovar','estoque_ajuste_massa_liberar','estoque_agrupamento_aplicar'))))
select * from (
  select 1 g, o, '1 migracao ' || mig grupo, item, case when ok then 'OK' else 'PROBLEMA' end situacao, '' detalhe from obj
  union all select 2, 1, '2 dados', 'agrupamentos existentes', 'OK', (select count(*)::text from public.estoque_agrupamento) || ' linha(s) — zero logo após a migração'
  union all select 2, 2, '2 dados', 'simulações de ajuste em massa', 'OK', (select count(*)::text from public.estoque_ajuste_massa_execucoes)
  union all select 3, 1, '3 fotografia', 'estoques (assinatura)', 'INFO', (select md5(coalesce(string_agg(empresa_id::text || sku || ':' || coalesce(estoque_atual::text, '-'), ',' order by empresa_id, sku, id), '')) from public.products)
  union all select 3, 2, '3 fotografia', 'produtos', 'INFO', (select count(*)::text from public.products)
  union all select 3, 3, '3 fotografia', 'movimentos de estoque', 'INFO', (select count(*)::text from public.estoque_movimentos)
  union all select 3, 4, '3 fotografia', 'itens na fila', 'INFO', (select count(*)::text from public.estoque_sync_fila)
  union all select 3, 5, '3 fotografia', 'divergências', 'INFO', (select count(*)::text from public.estoque_divergencias)
  union all select 3, 6, '3 fotografia', 'vínculos ML + Shopee', 'INFO', ((select count(*) from public.product_ml_links) + (select count(*) from public.product_shopee_links))::text
  union all select 3, 7, '3 fotografia', 'pedidos importados', 'INFO', (select count(*)::text from public.ml_orders)
  union all select 3, 8, '3 fotografia', 'movimentos dos últimos 60 min (por origem)', 'INFO',
    coalesce((select string_agg(origem || ': ' || n, ', ') from (select origem, count(*) n from public.estoque_movimentos where criado_em > now() - interval '60 minutes' group by origem) x), 'nenhum')
  union all select 3, 9, '3 fotografia', 'modo de envio / piloto (não pode ter mudado)', 'INFO', coalesce((select string_agg(modo || ' ' || coalesce(array_to_string(skus_piloto, ','), ''), ' · ') from public.estoque_sync_config), 'sem configuração')
) r order by g, o;
