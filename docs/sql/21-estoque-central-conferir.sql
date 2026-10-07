-- TMP10 — CONFERÊNCIA da migração 21 (SOMENTE LEITURA). Rode depois de aplicar. Cada linha deve dar "OK".
select 'tabelas novas (4)' as item, case when count(*) = 4 then 'OK' else 'FALTANDO' end as resultado
  from pg_class where relnamespace = 'public'::regnamespace
   and relname in ('estoque_movimentos','estoque_sync_fila','estoque_sync_log','estoque_sync_config')
union all
select 'RLS ligado e sem policy nas tabelas novas',
       case when bool_and(c.relrowsecurity) and not exists (select 1 from pg_policies p where p.schemaname = 'public'
            and p.tablename in ('estoque_movimentos','estoque_sync_fila','estoque_sync_log','estoque_sync_config')) then 'OK' else 'VERIFICAR' end
  from pg_class c where c.relnamespace = 'public'::regnamespace
   and c.relname in ('estoque_movimentos','estoque_sync_fila','estoque_sync_log','estoque_sync_config')
union all
select 'navegador sem acesso às tabelas novas',
       case when not has_table_privilege('authenticated', 'public.estoque_movimentos', 'select')
             and not has_table_privilege('anon', 'public.estoque_sync_fila', 'select') then 'OK' else 'VERIFICAR' end
union all
select 'funções novas (6) só para o backend',
       case when count(*) = 6 and bool_and(not has_function_privilege('authenticated', p.oid, 'execute')) then 'OK' else 'VERIFICAR' end
  from pg_proc p where p.pronamespace = 'public'::regnamespace
   and p.proname in ('estoque_movimentar','estoque_fila_enfileirar','estoque_fila_reservar','estoque_fila_concluir',
                     'estoque_divergencia_registrar','estoque_anuncio_tem_full')
union all
select 'gatilho de rastro em products',
       case when exists (select 1 from pg_trigger where tgname = 'estoque_rastro_alteracao' and not tgisinternal) then 'OK' else 'FALTANDO' end
union all
select 'modo de envio (sem linha = desligado)',
       coalesce((select string_agg(empresa_id || '=' || modo, ', ') from public.estoque_sync_config), 'OK: nenhuma empresa ligada (desligado)')
union all
select 'divergências antigas intactas (legado, chave vazia)',
       'OK: ' || count(*) || ' linhas' from public.estoque_divergencias where chave is null;
