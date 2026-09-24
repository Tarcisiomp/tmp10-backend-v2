-- Etapa 0 — passo 0.1: preencher a empresa das perguntas do Mercado Livre (ml_perguntas)
-- Hoje as 30 perguntas estão sem empresa_id. A empresa vem da conta (account_nickname → ml_accounts).
-- Rodar no Supabase → SQL Editor, EM DUAS PARTES.

-- PARTE A — só conferência (não altera nada). Rode primeiro e veja o resultado.
-- Mostra, para cada apelido de conta, quantas perguntas e a quantas empresas diferentes o apelido está ligado.
-- Se alguma linha tiver "empresas_com_esse_apelido" maior que 1, PARE e me avise.
select p.account_nickname,
       count(*)                                   as perguntas,
       count(distinct a.empresa_id)               as empresas_com_esse_apelido
from public.ml_perguntas p
left join public.ml_accounts a on a.nickname = p.account_nickname
where p.empresa_id is null
group by p.account_nickname
order by 1;

-- PARTE B — correção (só depois de conferir a parte A). Rode sozinha, em outra consulta.
-- Tudo ou nada: se sobrar alguma pergunta sem empresa, dá erro e NADA é alterado.
do $$
declare
  atualizadas integer;
  restantes integer;
begin
  update public.ml_perguntas p
     set empresa_id = a.empresa_id
    from public.ml_accounts a
   where p.empresa_id is null
     and a.nickname = p.account_nickname
     and a.empresa_id is not null;
  get diagnostics atualizadas = row_count;

  select count(*) into restantes from public.ml_perguntas where empresa_id is null;
  if restantes > 0 then
    raise exception 'Ainda ficaram % perguntas sem empresa — nada foi alterado. Me mande o resultado da PARTE A.', restantes;
  end if;

  raise notice 'OK: % perguntas receberam a empresa. Nenhuma ficou sem empresa.', atualizadas;
end $$;
