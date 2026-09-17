-- PostgreSQL does not define min(uuid). Pick the lowest teacher UUID explicitly.
create or replace function private.aggregate_usage_ledger() returns trigger language plpgsql security definer set search_path = '' as $$
declare class_teacher uuid;
begin
  select coalesce((select cm.user_id from public.class_members cm
    where cm.class_id=new.class_id and cm.role='teacher' and cm.status='active'
    order by cm.user_id limit 1),c.teacher_id)
    into class_teacher from public.classes c where c.id=new.class_id;
  insert into public.usage_daily(organization_id,usage_day,class_id,user_id,project_id,model_profile_id,provider,teacher_id,
    event_count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,known_cost_micros,unknown_cost_count)
    values(new.organization_id,(new.recorded_at at time zone 'UTC')::date,new.class_id,new.user_id,new.project_id,new.model_profile_id,new.provider,class_teacher,
      1,new.input_tokens,new.output_tokens,new.cache_read_tokens,new.cache_write_tokens,coalesce(new.estimated_cost_micros,0),
      case when new.estimated_cost_micros is null then 1 else 0 end)
  on conflict (organization_id,usage_day,class_id,user_id,project_id,model_profile_id,provider) do update set
    event_count=public.usage_daily.event_count+1,
    input_tokens=public.usage_daily.input_tokens+excluded.input_tokens,
    output_tokens=public.usage_daily.output_tokens+excluded.output_tokens,
    cache_read_tokens=public.usage_daily.cache_read_tokens+excluded.cache_read_tokens,
    cache_write_tokens=public.usage_daily.cache_write_tokens+excluded.cache_write_tokens,
    known_cost_micros=public.usage_daily.known_cost_micros+excluded.known_cost_micros,
    unknown_cost_count=public.usage_daily.unknown_cost_count+excluded.unknown_cost_count;
  return new;
end;
$$;

-- sum(bigint) returns numeric; cast to the declared aggregate contract.
create or replace function public.platform_usage_summary() returns table(organization_id uuid, usage_month date, input_tokens bigint, output_tokens bigint,
  known_cost_micros bigint, unknown_cost_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode='42501'; end if;
  return query select d.organization_id,date_trunc('month',d.usage_day)::date,
    sum(d.input_tokens)::bigint,sum(d.output_tokens)::bigint,
    sum(d.known_cost_micros)::bigint,sum(d.unknown_cost_count)::bigint
    from public.usage_daily d group by d.organization_id,date_trunc('month',d.usage_day);
end;
$$;

-- Supabase's RLS event trigger is internal and needs no Data API execution grant.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
