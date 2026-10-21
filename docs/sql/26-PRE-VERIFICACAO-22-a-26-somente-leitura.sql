-- TMP10 — PRÉ-VERIFICAÇÃO (SOMENTE LEITURA) antes das migrações 22 a 26. Não altera nada.
-- Supabase → SQL Editor → cole TUDO → Run (é UMA consulta só; o editor mostra uma tabela). Exporte/copie o resultado e guarde.
-- Para seguir: nenhuma linha com situacao = 'PROBLEMA' e a identidade tem de ser a do TMP10 oficial
-- (empresas Adao Materiais etc., PILOTO com 01-RL-LIN-50CM-BR). Linhas 'FALTA' no grupo 3 são esperadas antes de rodar.
with
fn(nome, args) as (values
  ('estoque_movimentar', 'p_empresa uuid, p_sku text, p_tipo text, p_quantidade integer, p_origem text, p_motivo text, p_referencia text, p_usuario uuid, p_processo text, p_esperado integer'),
  ('estoque_fila_enfileirar', 'p_empresa uuid, p_sku text, p_destino text, p_conta_ref text, p_anuncio text, p_variacao text, p_motivo text, p_movimento uuid'),
  ('estoque_fila_reservar', 'p_limite integer'),
  ('estoque_divergencia_registrar', 'p_empresa uuid, p_sku text, p_chave text, p_plataforma text, p_conta text, p_anuncio text, p_variacao text, p_tmp10 integer, p_plataforma_qtd integer'),
  ('estoque_anuncio_tem_full', 'p_empresa uuid, p_anuncio text, p_dias integer')),
col(tabela, coluna) as (values
  ('products','id'),('products','sku'),('products','name'),('products','estoque_atual'),('products','empresa_id'),('products','photo'),
  ('product_ml_links','sku'),('product_ml_links','account_nickname'),('product_ml_links','ml_item_id'),('product_ml_links','ml_user_id'),('product_ml_links','sincronizar'),('product_ml_links','ml_variation_id'),('product_ml_links','empresa_id'),
  ('product_shopee_links','sku'),('product_shopee_links','shop_id'),('product_shopee_links','item_id'),('product_shopee_links','model_id'),('product_shopee_links','sincronizar'),('product_shopee_links','empresa_id'),
  ('ml_accounts','nickname'),('ml_accounts','ml_user_id'),('ml_accounts','platform'),('ml_accounts','active'),('ml_accounts','empresa_id'),
  ('ml_orders','ml_order_id'),('ml_orders','empresa_id'),('ml_orders','platform'),('ml_orders','items'),('ml_orders','is_fulfillment'),('ml_orders','status'),('ml_orders','account_nickname'),('ml_orders','created_at_ml'),
  ('estoque_movimentos','referencia'),('estoque_movimentos','aplicado'),('estoque_movimentos','observacao'),('estoque_movimentos','origem'),
  ('estoque_sync_fila','conta_ref'),('estoque_sync_fila','variacao_id'),('estoque_sync_config','skus_piloto'),
  ('estoque_divergencias','chave'),('estoque_divergencias','resolvido'),('estoque_divergencias','ocorrencias'),('estoque_divergencias','estoque_ml'),
  ('users','id'),('users','name'),('users','empresa_id')),
mig(o, mig, item, ok) as (values
  (1, '22', 'função estoque_fila_enfileirar_lote', exists (select 1 from pg_proc where proname = 'estoque_fila_enfileirar_lote')),
  (2, '22', 'função estoque_anuncios_full', exists (select 1 from pg_proc where proname = 'estoque_anuncios_full')),
  (3, '23', 'índice estoque_divergencias_painel_idx', exists (select 1 from pg_indexes where indexname = 'estoque_divergencias_painel_idx')),
  (4, '23', 'índice estoque_divergencias_legado_idx', exists (select 1 from pg_indexes where indexname = 'estoque_divergencias_legado_idx')),
  (5, '24', 'tabela estoque_ajuste_massa_execucoes', to_regclass('public.estoque_ajuste_massa_execucoes') is not null),
  (6, '24', 'tabela estoque_ajuste_massa_eventos', to_regclass('public.estoque_ajuste_massa_eventos') is not null),
  (7, '24', 'tabela estoque_ajuste_massa_trava', to_regclass('public.estoque_ajuste_massa_trava') is not null),
  (8, '24', 'funções travar/renovar/liberar', (select count(*) from pg_proc where proname in ('estoque_ajuste_massa_travar','estoque_ajuste_massa_renovar','estoque_ajuste_massa_liberar')) = 3),
  (9, '25', 'regra plataforma mercadolivre/shopee/multi', exists (select 1 from pg_constraint where conname = 'estoque_ajuste_massa_execucoes_plataforma_check' and pg_get_constraintdef(oid) ilike '%multi%')),
  (10, '26', 'tabela estoque_agrupamento', to_regclass('public.estoque_agrupamento') is not null),
  (11, '26', 'tabela estoque_agrupamento_eventos', to_regclass('public.estoque_agrupamento_eventos') is not null),
  (12, '26', 'função estoque_agrupamento_aplicar', exists (select 1 from pg_proc where proname = 'estoque_agrupamento_aplicar')))
select * from (
  -- 1) que banco é este
  select 1 g, 1 o, '1 identidade' grupo, 'banco / versão' item, 'INFO' situacao, current_database() || ' / ' || split_part(version(), ' ', 2) detalhe
  union all select 1, 2, '1 identidade', 'consultado em', 'INFO', now()::text
  union all select 1, 3, '1 identidade', 'empresas', 'INFO', (select string_agg(coalesce(nome_empresa, '?') || ' [' || coalesce(status, '?') || ']', ', ' order by nome_empresa) from public.empresas)
  union all select 1, 4, '1 identidade', 'modo de envio / piloto', 'INFO', coalesce((select string_agg(modo || ' ' || coalesce(array_to_string(skus_piloto, ','), ''), ' · ') from public.estoque_sync_config), 'sem configuração (= desligado)')
  union all select 1, 5, '1 identidade', 'objetos estoque_ajuste_massa*/estoque_agrupamento* em QUALQUER schema', 'INFO',
    coalesce((select string_agg(table_schema || '.' || table_name, ', ') from information_schema.tables where table_name like 'estoque_ajuste_massa%' or table_name like 'estoque_agrupamento%'), 'nenhum')
  -- 2) pré-requisitos (migração 21 e colunas usadas)
  union all
  select 2, 0, '2 pre-requisito', 'função ' || f.nome,
    case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f.nome and pg_get_function_identity_arguments(p.oid) = f.args) then 'OK' else 'PROBLEMA' end,
    coalesce((select string_agg(pg_get_function_identity_arguments(p.oid), ' | ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = f.nome), 'não existe')
  from fn f
  union all
  select 2, 1, '2 pre-requisito', 'coluna ' || c.tabela || '.' || c.coluna, case when i.column_name is null then 'PROBLEMA' else 'OK' end, coalesce(i.data_type, 'não existe')
  from col c left join information_schema.columns i on i.table_schema = 'public' and i.table_name = c.tabela and i.column_name = c.coluna
  union all
  select 2, 2, '2 pre-requisito', 'índice único da fila (usado pela 21/22)',
    case when exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'estoque_sync_fila' and indexdef ilike '%unique%' and indexdef ilike '%(empresa_id, destino, conta_ref, anuncio_id, variacao_id)%') then 'OK' else 'PROBLEMA' end, ''
  union all
  select 2, 2, '2 pre-requisito', 'índice de idempotência dos movimentos',
    case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'estoque_movimentos_referencia_uq') then 'OK' else 'PROBLEMA' end, ''
  union all
  select 2, 2, '2 pre-requisito', 'papéis anon / authenticated / service_role', case when (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')) = 3 then 'OK' else 'PROBLEMA' end, ''
  -- 3) estado atual das migrações
  union all
  select 3, m.o, '3 migracao ' || m.mig, m.item, case when m.ok then 'APLICADA' else 'FALTA' end, '' from mig m
  -- 4) fotografia dos dados (compare com a pós-verificação)
  union all select 4, 1, '4 fotografia', 'estoques (assinatura)', 'INFO', (select md5(coalesce(string_agg(empresa_id::text || sku || ':' || coalesce(estoque_atual::text, '-'), ',' order by empresa_id, sku, id), '')) from public.products)
  union all select 4, 2, '4 fotografia', 'produtos', 'INFO', (select count(*)::text from public.products)
  union all select 4, 3, '4 fotografia', 'movimentos de estoque', 'INFO', (select count(*)::text from public.estoque_movimentos)
  union all select 4, 4, '4 fotografia', 'itens na fila', 'INFO', (select count(*)::text from public.estoque_sync_fila)
  union all select 4, 5, '4 fotografia', 'divergências', 'INFO', (select count(*)::text from public.estoque_divergencias)
  union all select 4, 6, '4 fotografia', 'vínculos ML + Shopee', 'INFO', ((select count(*) from public.product_ml_links) + (select count(*) from public.product_shopee_links))::text
  union all select 4, 7, '4 fotografia', 'pedidos importados', 'INFO', (select count(*)::text from public.ml_orders)
) r order by g, o, item;
