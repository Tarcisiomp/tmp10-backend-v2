-- TMP10 — DEPOIS da migração 27: conferência SOMENTE LEITURA. Todas as linhas devem vir com ok = true.
select ordem, item, ok from (values
  (1, 'tabelas estoque_full_saldos e estoque_full_leituras existem', to_regclass('public.estoque_full_saldos') is not null and to_regclass('public.estoque_full_leituras') is not null),
  (2, 'RLS ligado nas duas tabelas', (select bool_and(relrowsecurity) from pg_class where oid in ('public.estoque_full_saldos'::regclass, 'public.estoque_full_leituras'::regclass))),
  (3, 'backend: só SELECT nas tabelas (grava só pela função)', (select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'estoque_full_saldos' and grantee = 'service_role') = 'SELECT'),
  (4, 'navegador (anon/authenticated) sem acesso às tabelas', not exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name like 'estoque_full%' and grantee in ('anon','authenticated'))),
  (5, 'backend executa estoque_full_registrar e estoque_saldo_normal_resumo', has_function_privilege('service_role', 'public.estoque_full_registrar(uuid,jsonb,uuid)', 'execute') and has_function_privilege('service_role', 'public.estoque_saldo_normal_resumo(uuid,text[])', 'execute')),
  (6, 'navegador NÃO executa as funções novas', not has_function_privilege('anon', 'public.estoque_full_registrar(uuid,jsonb,uuid)', 'execute') and not has_function_privilege('authenticated', 'public.estoque_full_registrar(uuid,jsonb,uuid)', 'execute')),
  (7, 'histórico protegido (gatilhos de imutabilidade)', (select count(*) from pg_trigger where tgrelid = 'public.estoque_full_leituras'::regclass and not tgisinternal) = 2),
  (8, 'regra "falha nunca vira zero" ativa (check)', exists (select 1 from pg_constraint where conrelid = 'public.estoque_full_saldos'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%situacao <> %')),
  (9, 'função estoque_anuncios_full (22) disponível', exists (select 1 from pg_proc where proname = 'estoque_anuncios_full')),
  (10, 'nenhum saldo Full gravado ainda (só depois de "Consultar Full")', not exists (select 1 from public.estoque_full_saldos))
) t(ordem, item, ok) order by ordem;
