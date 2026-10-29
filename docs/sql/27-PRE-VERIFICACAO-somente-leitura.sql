-- TMP10 — ANTES da migração 27: diagnóstico SOMENTE LEITURA (não altera nada). Supabase → SQL Editor → cole tudo → Run.
-- Explica o erro "Could not find the function public.estoque_anuncios_full(p_dias, p_empresa) in the schema cache"
-- e diz o que falta aplicar. (Para conferir 22–26 item a item, use também 26-POS-VERIFICACAO-22-a-26-somente-leitura.sql.)
select ordem, item, situacao, detalhe from (values
  (1, 'função estoque_anuncios_full (criada pela migração 22)',
     case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'estoque_anuncios_full')
          then 'EXISTE' else 'FALTA — é a causa do erro: aplique a 22' end,
     coalesce((select string_agg('estoque_anuncios_full(' || pg_get_function_identity_arguments(p.oid) || ')', ' | ') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'estoque_anuncios_full'),
              'nenhuma versão no banco. O backend chama com (p_empresa uuid, p_dias integer) — exatamente a assinatura da 22')),
  (2, 'backend (service_role) pode executar estoque_anuncios_full',
     case when to_regprocedure('public.estoque_anuncios_full(uuid,integer)') is null then '— (função ausente)'
          when has_function_privilege('service_role', 'public.estoque_anuncios_full(uuid,integer)', 'execute') then 'OK' else 'SEM PERMISSÃO — rode a 22 de novo' end, ''),
  (3, 'migração 22 (estoque_fila_enfileirar_lote + estoque_anuncios_full)', case when exists (select 1 from pg_proc where proname = 'estoque_fila_enfileirar_lote') and exists (select 1 from pg_proc where proname = 'estoque_anuncios_full') then 'APLICADA' else 'FALTA' end, ''),
  (4, 'migração 23 (índices de divergências)', case when exists (select 1 from pg_indexes where indexname = 'estoque_divergencias_painel_idx') then 'APLICADA' else 'FALTA' end, ''),
  (5, 'migração 24 (ajuste em massa)', case when to_regclass('public.estoque_ajuste_massa_trava') is not null then 'APLICADA' else 'FALTA' end, ''),
  (6, 'migração 25 (ajuste em massa Shopee)', case when exists (select 1 from pg_constraint where conname = 'estoque_ajuste_massa_execucoes_plataforma_check' and pg_get_constraintdef(oid) ilike '%multi%') then 'APLICADA' else 'FALTA' end, ''),
  (7, 'migração 26 (agrupamento)', case when to_regclass('public.estoque_agrupamento') is not null then 'APLICADA' else 'FALTA' end, ''),
  (8, 'migração 27 (Full por anúncio)', case when to_regclass('public.estoque_full_saldos') is not null then 'JÁ APLICADA' else 'AINDA NÃO (esperado antes de rodar)' end, ''),
  (9, 'nenhuma função com o nome das novas da 27', case when to_regclass('public.estoque_full_saldos') is null and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
     and p.proname in ('estoque_full_registrar','estoque_saldo_normal_resumo','estoque_full_imutavel')) then 'ATENÇÃO — já existe função com esse nome; NÃO aplique e me envie o resultado' else 'OK' end, '')
) t(ordem, item, situacao, detalhe) order by ordem;
