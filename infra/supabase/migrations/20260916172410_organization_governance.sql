-- Organization V1 governance. No provider credentials are stored in public tables.
create table public.model_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 120),
  provider text not null check (provider ~ '^[a-z0-9_-]{2,80}$'),
  provider_model text not null check (length(trim(provider_model)) between 1 and 200),
  allowed_thinking_levels text[] not null default array['off','low','medium','high'],
  available boolean not null default true,
  fallback_profile_id uuid references public.model_profiles(id) on delete set null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  check (array_length(allowed_thinking_levels, 1) between 1 and 7),
  check (allowed_thinking_levels <@ array['off','minimal','low','medium','high','xhigh','max']::text[])
);
create index model_profiles_org_idx on public.model_profiles(organization_id, available);

create type public.governance_policy_scope as enum ('organization','class','project');
create table public.governance_policies (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope public.governance_policy_scope not null,
  class_id uuid references public.classes(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object' and length(settings::text) <= 10000),
  delegated_paths text[] not null default '{}',
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  check ((scope = 'organization' and class_id is null and project_id is null) or
    (scope = 'class' and class_id is not null and project_id is null) or
    (scope = 'project' and class_id is not null and project_id is not null))
);
create unique index governance_policy_org_unique on public.governance_policies(organization_id) where scope = 'organization';
create unique index governance_policy_class_unique on public.governance_policies(class_id) where scope = 'class';
create unique index governance_policy_project_unique on public.governance_policies(project_id) where scope = 'project';
create index governance_policies_org_idx on public.governance_policies(organization_id, scope);

create table public.model_prices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null references public.model_profiles(id) on delete cascade,
  price_version text not null check (length(price_version) between 1 and 80),
  input_micros_per_million bigint not null check (input_micros_per_million >= 0),
  output_micros_per_million bigint not null check (output_micros_per_million >= 0),
  cache_read_micros_per_million bigint not null default 0 check (cache_read_micros_per_million >= 0),
  cache_write_micros_per_million bigint not null default 0 check (cache_write_micros_per_million >= 0),
  effective_from timestamptz not null default now(),
  unique (profile_id, price_version)
);
create index model_prices_current_idx on public.model_prices(profile_id, effective_from desc);

create type public.budget_scope as enum ('organization','class','user','model');
create type public.budget_hard_action as enum ('block_model','fallback','block_ai');
create table public.organization_budgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope public.budget_scope not null,
  class_id uuid references public.classes(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  model_profile_id uuid references public.model_profiles(id) on delete cascade,
  monthly_cost_limit_micros bigint check (monthly_cost_limit_micros > 0),
  monthly_token_limit bigint check (monthly_token_limit > 0),
  warning_fraction numeric(4,3) not null default 0.800 check (warning_fraction > 0 and warning_fraction <= 1),
  hard_action public.budget_hard_action not null default 'block_ai',
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  check (monthly_cost_limit_micros is not null or monthly_token_limit is not null),
  check ((scope = 'organization' and class_id is null and user_id is null and model_profile_id is null) or
    (scope = 'class' and class_id is not null and user_id is null and model_profile_id is null) or
    (scope = 'user' and class_id is null and user_id is not null and model_profile_id is null) or
    (scope = 'model' and class_id is null and user_id is null and model_profile_id is not null))
);
create unique index budget_org_unique on public.organization_budgets(organization_id) where scope = 'organization';
create unique index budget_class_unique on public.organization_budgets(organization_id,class_id) where scope = 'class';
create unique index budget_user_unique on public.organization_budgets(organization_id,user_id) where scope = 'user';
create unique index budget_model_unique on public.organization_budgets(organization_id,model_profile_id) where scope = 'model';
create index organization_budgets_org_idx on public.organization_budgets(organization_id, scope);

create table public.usage_ledger (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete restrict,
  class_id uuid not null references public.classes(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  project_id uuid references public.projects(id) on delete set null,
  session_id uuid not null,
  model_profile_id uuid not null references public.model_profiles(id) on delete restrict,
  provider text not null,
  provider_model text not null,
  resource text not null default 'model_tokens' check (resource in ('model_tokens','sandbox_compute','storage','other')),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cache_read_tokens bigint not null default 0 check (cache_read_tokens >= 0),
  cache_write_tokens bigint not null default 0 check (cache_write_tokens >= 0),
  estimated_cost_micros bigint check (estimated_cost_micros >= 0),
  pricing_version text,
  recorded_at timestamptz not null default now(),
  source text not null default 'client_reported' check (source in ('client_reported','gateway')),
  check ((estimated_cost_micros is null) = (pricing_version is null))
);
create index usage_ledger_org_day_idx on public.usage_ledger(organization_id, recorded_at desc);
create index usage_ledger_class_day_idx on public.usage_ledger(class_id, recorded_at desc);
create index usage_ledger_user_day_idx on public.usage_ledger(user_id, recorded_at desc);
create index usage_ledger_project_day_idx on public.usage_ledger(project_id, recorded_at desc);
create index usage_ledger_model_day_idx on public.usage_ledger(model_profile_id, recorded_at desc);

-- Daily slices keep dashboards off the event ledger. Monthly totals roll up days.
create table public.usage_daily (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  usage_day date not null,
  class_id uuid not null,
  user_id uuid not null,
  project_id uuid,
  model_profile_id uuid not null,
  provider text not null,
  teacher_id uuid,
  event_count bigint not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  known_cost_micros bigint not null default 0,
  unknown_cost_count bigint not null default 0,
  check (event_count >= 0)
);
create index usage_daily_org_month_idx on public.usage_daily(organization_id, usage_day);
create unique index usage_daily_dimensions_idx on public.usage_daily(organization_id,usage_day,class_id,user_id,project_id,model_profile_id,provider) nulls not distinct;
create index usage_daily_teacher_idx on public.usage_daily(teacher_id, usage_day);
create index usage_daily_project_idx on public.usage_daily(project_id, usage_day);

alter table public.model_profiles enable row level security;
alter table public.governance_policies enable row level security;
alter table public.model_prices enable row level security;
alter table public.organization_budgets enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.usage_daily enable row level security;
revoke all on public.model_profiles, public.governance_policies, public.model_prices,
  public.organization_budgets, public.usage_ledger, public.usage_daily from public, anon, authenticated;
grant select on public.model_profiles, public.governance_policies, public.model_prices,
  public.organization_budgets, public.usage_daily to authenticated;
create policy model_profiles_admin_read on public.model_profiles for select to authenticated
  using (private.can_administer_organization(organization_id) and private.has_organization_entitlement(organization_id,'model_governance'));
create policy governance_policies_admin_read on public.governance_policies for select to authenticated
  using (private.can_administer_organization(organization_id) and private.has_organization_entitlement(organization_id,'model_governance'));
create policy model_prices_admin_read on public.model_prices for select to authenticated
  using (private.can_administer_organization(organization_id) and private.has_organization_entitlement(organization_id,'model_governance'));
create policy budgets_admin_read on public.organization_budgets for select to authenticated
  using (private.can_administer_organization(organization_id) and private.has_organization_entitlement(organization_id,'budget_controls'));
create policy usage_daily_admin_read on public.usage_daily for select to authenticated
  using (private.can_administer_organization(organization_id) and private.has_organization_entitlement(organization_id,'usage_dashboard'));
-- No student direct table access or client writes to ledger or aggregates.

create function private.version_governance_row() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then new.version := old.version + 1; new.updated_at := now(); end if;
  return new;
end;
$$;
create trigger version_model_profiles before update on public.model_profiles for each row execute function private.version_governance_row();
create trigger version_governance_policies before update on public.governance_policies for each row execute function private.version_governance_row();
create trigger version_organization_budgets before update on public.organization_budgets for each row execute function private.version_governance_row();
revoke all on function private.version_governance_row() from public, anon, authenticated;

-- Existing audit stream records sensitive changes without copying secrets or student work.
create function private.audit_governance_change() returns trigger language plpgsql security definer set search_path = '' as $$
declare row_id uuid; org_id uuid;
begin
  row_id := case when tg_op = 'DELETE' then old.id else new.id end;
  org_id := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
  insert into public.administrative_audit_events(actor_user_id, organization_id, action, target_type, target_id, details)
    values (auth.uid(), org_id, lower(tg_op), tg_table_name, row_id::text, '{}'::jsonb);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.audit_governance_change() from public, anon, authenticated;
create trigger audit_model_profiles after insert or update or delete on public.model_profiles for each row execute function private.audit_governance_change();
create trigger audit_governance_policies after insert or update or delete on public.governance_policies for each row execute function private.audit_governance_change();
create trigger audit_organization_budgets after insert or update or delete on public.organization_budgets for each row execute function private.audit_governance_change();
create trigger audit_model_prices after insert or update or delete on public.model_prices for each row execute function private.audit_governance_change();

create function public.save_model_profile(organization_id_input uuid, profile_id_input uuid, display_name_input text,
  provider_input text, provider_model_input text, levels_input text[], available_input boolean, fallback_id_input uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare resolved_id uuid;
begin
  if not private.can_administer_organization(organization_id_input) or not private.has_organization_entitlement(organization_id_input,'model_governance') then
    raise exception 'Model governance required' using errcode = '42501'; end if;
  if fallback_id_input is not null and not exists (select 1 from public.model_profiles where id = fallback_id_input and organization_id = organization_id_input) then
    raise exception 'Fallback must belong to organization' using errcode = '22023'; end if;
  if profile_id_input is null then
    insert into public.model_profiles(organization_id,display_name,provider,provider_model,allowed_thinking_levels,available,fallback_profile_id)
    values (organization_id_input,display_name_input,provider_input,provider_model_input,levels_input,available_input,fallback_id_input)
    returning id into resolved_id;
  else
    update public.model_profiles set display_name=display_name_input,provider=provider_input,provider_model=provider_model_input,
      allowed_thinking_levels=levels_input,available=available_input,fallback_profile_id=fallback_id_input
      where id=profile_id_input and organization_id=organization_id_input returning id into resolved_id;
    if resolved_id is null then raise exception 'Profile not found' using errcode = '42501'; end if;
  end if;
  return resolved_id;
end;
$$;
revoke all on function public.save_model_profile(uuid,uuid,text,text,text,text[],boolean,uuid) from public, anon;
grant execute on function public.save_model_profile(uuid,uuid,text,text,text,text[],boolean,uuid) to authenticated;

create function public.save_governance_policy(organization_id_input uuid, scope_input public.governance_policy_scope,
  class_id_input uuid, project_id_input uuid, settings_input jsonb, delegated_paths_input text[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare existing_id uuid; resolved_id uuid; allowed text[]; policy_path text;
begin
  if not private.can_administer_organization(organization_id_input) or not private.has_organization_entitlement(organization_id_input,'model_governance') then
    if scope_input not in ('class','project') or class_id_input is null or not private.is_class_teacher(class_id_input) or
      not private.has_organization_entitlement(organization_id_input,'model_governance') then
      raise exception 'Policy administration required' using errcode = '42501'; end if;
  end if;
  if scope_input = 'organization' and (class_id_input is not null or project_id_input is not null) then raise exception 'Invalid scope' using errcode = '22023'; end if;
  if scope_input <> 'organization' and not exists (select 1 from public.classes where id=class_id_input and organization_id=organization_id_input) then raise exception 'Class outside organization' using errcode='42501'; end if;
  if scope_input = 'project' and not exists (select 1 from public.projects where id=project_id_input and class_id=class_id_input) then raise exception 'Project outside class' using errcode='42501'; end if;
  if scope_input = 'class' and project_id_input is not null then raise exception 'Invalid scope' using errcode='22023'; end if;
  if scope_input <> 'organization' and delegated_paths_input <> '{}'::text[] then raise exception 'Only organization policy may delegate settings' using errcode='42501'; end if;
  if jsonb_typeof(settings_input) <> 'object' or length(settings_input::text) > 10000 then raise exception 'Invalid policy' using errcode='22023'; end if;
  allowed := array['fileEditing','terminal','dependencyInstallation','internet','desktopExport','imageUploads','fileUploads','reflection',
    'models','reasoningLevels','limits.minutes','limits.turns','limits.tokens','limits.cost',
    'accessibility.dictation','accessibility.cloudDictation','accessibility.readAloud','accessibility.simplifiedVocabulary','accessibility.readableFormatting'];
  for policy_path in
    select key from jsonb_object_keys(settings_input) as t(key) where key not in ('limits','accessibility')
    union all select 'limits.'||key from jsonb_object_keys(coalesce(settings_input->'limits','{}'::jsonb)) as t(key)
    union all select 'accessibility.'||key from jsonb_object_keys(coalesce(settings_input->'accessibility','{}'::jsonb)) as t(key)
  loop
    if not policy_path = any(allowed) then raise exception 'Unknown policy setting' using errcode='22023'; end if;
    if scope_input <> 'organization' then
      select g.delegated_paths into allowed from public.governance_policies g
        where g.organization_id=organization_id_input and g.scope='organization';
      if allowed is null or not policy_path = any(allowed) then raise exception 'Teacher setting is not delegated' using errcode='42501'; end if;
    end if;
  end loop;
  if delegated_paths_input is null or not (delegated_paths_input <@ array['fileEditing','terminal','dependencyInstallation','internet','desktopExport',
    'imageUploads','fileUploads','reflection','models','reasoningLevels','limits.minutes','limits.turns','limits.tokens','limits.cost',
    'accessibility.dictation','accessibility.cloudDictation','accessibility.readAloud','accessibility.simplifiedVocabulary','accessibility.readableFormatting']::text[]) then
    raise exception 'Invalid delegated path' using errcode='22023'; end if;
  -- Teachers may only configure delegated paths, and cannot delegate further.
  if not private.can_administer_organization(organization_id_input) then
    if delegated_paths_input <> '{}'::text[] or exists (
      select 1 from jsonb_object_keys(settings_input) k where k not in ('reasoningLevels','models','reflection','accessibility','limits')
    ) then raise exception 'Teacher setting is not delegated' using errcode='42501'; end if;
  end if;
  select id into existing_id from public.governance_policies where organization_id=organization_id_input and scope=scope_input
    and ((scope_input='organization') or (scope_input='class' and class_id=class_id_input) or (scope_input='project' and project_id=project_id_input));
  if existing_id is null then
    insert into public.governance_policies(organization_id,scope,class_id,project_id,settings,delegated_paths)
      values(organization_id_input,scope_input,class_id_input,project_id_input,settings_input,delegated_paths_input) returning id into resolved_id;
  else
    update public.governance_policies set settings=settings_input, delegated_paths=delegated_paths_input
      where id=existing_id returning id into resolved_id;
  end if;
  return resolved_id;
end;
$$;
revoke all on function public.save_governance_policy(uuid,public.governance_policy_scope,uuid,uuid,jsonb,text[]) from public, anon;
grant execute on function public.save_governance_policy(uuid,public.governance_policy_scope,uuid,uuid,jsonb,text[]) to authenticated;

create function public.save_organization_budget(organization_id_input uuid, scope_input public.budget_scope,
  class_id_input uuid, user_id_input uuid, model_profile_id_input uuid,
  cost_limit_input bigint, token_limit_input bigint, warning_fraction_input numeric, action_input public.budget_hard_action)
returns uuid language plpgsql security definer set search_path = '' as $$
declare existing_id uuid; resolved_id uuid;
begin
  if not private.can_administer_organization(organization_id_input) or not private.has_organization_entitlement(organization_id_input,'budget_controls') then
    raise exception 'Budget administration required' using errcode='42501'; end if;
  if class_id_input is not null and not exists (select 1 from public.classes where id=class_id_input and organization_id=organization_id_input) then raise exception 'Class outside organization' using errcode='42501'; end if;
  if model_profile_id_input is not null and not exists (select 1 from public.model_profiles where id=model_profile_id_input and organization_id=organization_id_input) then raise exception 'Model outside organization' using errcode='42501'; end if;
  if user_id_input is not null and not exists (select 1 from public.class_members cm join public.classes c on c.id=cm.class_id where cm.user_id=user_id_input and c.organization_id=organization_id_input and cm.status='active') then raise exception 'User outside organization' using errcode='42501'; end if;
  select id into existing_id from public.organization_budgets where organization_id=organization_id_input and scope=scope_input
    and ((scope_input='organization') or (scope_input='class' and class_id=class_id_input) or
      (scope_input='user' and user_id=user_id_input) or (scope_input='model' and model_profile_id=model_profile_id_input));
  if existing_id is null then
    insert into public.organization_budgets(organization_id,scope,class_id,user_id,model_profile_id,monthly_cost_limit_micros,monthly_token_limit,warning_fraction,hard_action)
      values(organization_id_input,scope_input,class_id_input,user_id_input,model_profile_id_input,cost_limit_input,token_limit_input,warning_fraction_input,action_input) returning id into resolved_id;
  else
    update public.organization_budgets set monthly_cost_limit_micros=cost_limit_input,monthly_token_limit=token_limit_input,
      warning_fraction=warning_fraction_input,hard_action=action_input where id=existing_id returning id into resolved_id;
  end if;
  return resolved_id;
end;
$$;
revoke all on function public.save_organization_budget(uuid,public.budget_scope,uuid,uuid,uuid,bigint,bigint,numeric,public.budget_hard_action) from public, anon;
grant execute on function public.save_organization_budget(uuid,public.budget_scope,uuid,uuid,uuid,bigint,bigint,numeric,public.budget_hard_action) to authenticated;

create function public.save_model_price(organization_id_input uuid, profile_id_input uuid, version_input text,
  input_price_input bigint, output_price_input bigint, cache_read_price_input bigint, cache_write_price_input bigint)
returns uuid language plpgsql security definer set search_path = '' as $$
declare created_id uuid;
begin
  if not private.can_administer_organization(organization_id_input) or not private.has_organization_entitlement(organization_id_input,'model_governance') then
    raise exception 'Model governance required' using errcode='42501'; end if;
  if not exists (select 1 from public.model_profiles where id=profile_id_input and organization_id=organization_id_input) then
    raise exception 'Profile outside organization' using errcode='42501'; end if;
  insert into public.model_prices(organization_id,profile_id,price_version,input_micros_per_million,output_micros_per_million,
    cache_read_micros_per_million,cache_write_micros_per_million)
    values(organization_id_input,profile_id_input,version_input,input_price_input,output_price_input,cache_read_price_input,cache_write_price_input)
    returning id into created_id;
  return created_id;
end;
$$;
revoke all on function public.save_model_price(uuid,uuid,text,bigint,bigint,bigint,bigint) from public, anon;
grant execute on function public.save_model_price(uuid,uuid,text,bigint,bigint,bigint,bigint) to authenticated;

create function public.governance_context(project_id_input uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare class_row record; result jsonb;
begin
  select p.id project_id,p.class_id,p.capability_policy,p.policy_version,c.organization_id into class_row
    from public.projects p join public.classes c on c.id=p.class_id where p.id=project_id_input;
  if class_row.organization_id is null or not private.is_active_class_member(class_row.class_id) then
    raise exception 'Managed project access required' using errcode='42501'; end if;
  select jsonb_build_object('organizationId',class_row.organization_id,'classId',class_row.class_id,
    'project',jsonb_build_object('scope','project','version',class_row.policy_version,'settings',class_row.capability_policy),
    'layers',coalesce(jsonb_agg(jsonb_build_object('scope',g.scope,'version',g.version,'settings',g.settings,'delegatedPaths',g.delegated_paths)) filter (where g.id is not null),'[]'::jsonb))
    into result from public.governance_policies g where g.organization_id=class_row.organization_id
      and (g.scope='organization' or (g.scope='class' and g.class_id=class_row.class_id) or (g.scope='project' and g.project_id=project_id_input));
  return result;
end;
$$;
revoke all on function public.governance_context(uuid) from public, anon;
grant execute on function public.governance_context(uuid) to authenticated;

create function public.approved_model_profiles(project_id_input uuid) returns table(
  id uuid, organization_id uuid, display_name text, provider text, provider_model text,
  allowed_thinking_levels text[], available boolean, fallback_profile_id uuid, version integer)
language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid; class_key uuid;
begin
  select c.organization_id,c.id into org_id,class_key from public.projects p join public.classes c on c.id=p.class_id where p.id=project_id_input;
  if org_id is null or not private.is_active_class_member(class_key) then raise exception 'Managed project access required' using errcode='42501'; end if;
  return query select m.id,m.organization_id,m.display_name,m.provider,m.provider_model,m.allowed_thinking_levels,m.available,m.fallback_profile_id,m.version
    from public.model_profiles m where m.organization_id=org_id and m.available and private.has_organization_entitlement(org_id,'model_governance');
end;
$$;
revoke all on function public.approved_model_profiles(uuid) from public, anon;
grant execute on function public.approved_model_profiles(uuid) to authenticated;

-- Platform operators see aggregate counts only, never tenant ledger rows.
create function public.platform_usage_summary() returns table(organization_id uuid, usage_month date, input_tokens bigint, output_tokens bigint,
  known_cost_micros bigint, unknown_cost_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode='42501'; end if;
  return query select d.organization_id,date_trunc('month',d.usage_day)::date,sum(d.input_tokens),sum(d.output_tokens),
    sum(d.known_cost_micros),sum(d.unknown_cost_count) from public.usage_daily d
    group by d.organization_id,date_trunc('month',d.usage_day);
end;
$$;
revoke all on function public.platform_usage_summary() from public, anon;
grant execute on function public.platform_usage_summary() to authenticated;

-- Authenticated records are explicitly marked client-reported. This is an
-- idempotent event stream, never a source of authoritative provider billing.
create function public.record_reported_model_usage(event_id_input uuid, project_id_input uuid, session_id_input uuid,
  provider_input text, model_input text, input_tokens_input bigint, output_tokens_input bigint,
  cache_read_tokens_input bigint default 0, cache_write_tokens_input bigint default 0)
returns void language plpgsql security definer set search_path = '' as $$
declare context_row record; profile_row record; price_row record; estimated bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if input_tokens_input < 0 or output_tokens_input < 0 or cache_read_tokens_input < 0 or cache_write_tokens_input < 0 or
    greatest(input_tokens_input,output_tokens_input,cache_read_tokens_input,cache_write_tokens_input) > 100000000 then
    raise exception 'Invalid usage' using errcode='22023'; end if;
  select p.class_id,c.organization_id into context_row from public.projects p join public.classes c on c.id=p.class_id where p.id=project_id_input;
  if context_row.organization_id is null or not private.is_active_class_member(context_row.class_id) or
    not exists (select 1 from public.class_members cm where cm.class_id=context_row.class_id and cm.user_id=auth.uid() and cm.role='student' and cm.status='active') then
    raise exception 'Managed student project required' using errcode='42501'; end if;
  select * into profile_row from public.model_profiles m where m.organization_id=context_row.organization_id and
    provider_input='institution' and m.id::text=model_input and m.available;
  if profile_row.id is null or not private.has_organization_entitlement(context_row.organization_id,'model_governance') then
    raise exception 'Model is not approved' using errcode='42501'; end if;
  select * into price_row from public.model_prices mp where mp.profile_id=profile_row.id and mp.effective_from <= now()
    order by mp.effective_from desc limit 1;
  if price_row.id is not null then
    estimated := ceil((input_tokens_input::numeric * price_row.input_micros_per_million +
      output_tokens_input::numeric * price_row.output_micros_per_million +
      cache_read_tokens_input::numeric * price_row.cache_read_micros_per_million +
      cache_write_tokens_input::numeric * price_row.cache_write_micros_per_million) / 1000000)::bigint;
  end if;
  insert into public.usage_ledger(id,organization_id,class_id,user_id,project_id,session_id,model_profile_id,provider,provider_model,
    input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost_micros,pricing_version,source)
    values(event_id_input,context_row.organization_id,context_row.class_id,auth.uid(),project_id_input,session_id_input,
      profile_row.id,profile_row.provider,profile_row.provider_model,input_tokens_input,output_tokens_input,
      cache_read_tokens_input,cache_write_tokens_input,estimated,price_row.price_version,'client_reported')
    on conflict (id) do nothing;
end;
$$;
revoke all on function public.record_reported_model_usage(uuid,uuid,uuid,text,text,bigint,bigint,bigint,bigint) from public, anon, authenticated;

create function private.aggregate_usage_ledger() returns trigger language plpgsql security definer set search_path = '' as $$
declare class_teacher uuid;
begin
  select coalesce((select min(cm.user_id) from public.class_members cm where cm.class_id=new.class_id and cm.role='teacher' and cm.status='active'),c.teacher_id)
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
revoke all on function private.aggregate_usage_ledger() from public, anon, authenticated;
create trigger aggregate_usage_ledger after insert on public.usage_ledger for each row execute function private.aggregate_usage_ledger();

-- A preflight check is useful for the honest client, but strict hard limits
-- require the provider request itself to pass through a trusted gateway.
create function public.check_model_budget(project_id_input uuid, profile_id_input uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare class_key uuid; org_id uuid; spent bigint; tokens bigint; unknown_count bigint; warning boolean := false; blocked boolean := false; action text;
  b record; ratio numeric;
begin
  select p.class_id,c.organization_id into class_key,org_id from public.projects p join public.classes c on c.id=p.class_id where p.id=project_id_input;
  if org_id is null or not private.is_active_class_member(class_key) or not exists (
    select 1 from public.model_profiles where id=profile_id_input and organization_id=org_id and available
  ) then raise exception 'Approved model access required' using errcode='42501'; end if;
  for b in select * from public.organization_budgets where organization_id=org_id and
    (scope='organization' or (scope='class' and class_id=class_key) or (scope='user' and user_id=auth.uid()) or
      (scope='model' and model_profile_id=profile_id_input)) loop
    select coalesce(sum(d.known_cost_micros),0),coalesce(sum(d.input_tokens+d.output_tokens+d.cache_read_tokens+d.cache_write_tokens),0),
      coalesce(sum(d.unknown_cost_count),0)
      into spent,tokens,unknown_count from public.usage_daily d where d.organization_id=org_id and d.usage_day >= date_trunc('month',now() at time zone 'UTC')::date
      and (b.scope='organization' or (b.scope='class' and d.class_id=class_key) or
        (b.scope='user' and d.user_id=auth.uid()) or (b.scope='model' and d.model_profile_id=profile_id_input));
    ratio := greatest(case when b.monthly_cost_limit_micros is null then 0 else spent::numeric/b.monthly_cost_limit_micros end,
      case when b.monthly_token_limit is null then 0 else tokens::numeric/b.monthly_token_limit end);
    if ratio >= b.warning_fraction then warning := true; end if;
    if b.monthly_cost_limit_micros is not null and (unknown_count > 0 or not exists (
      select 1 from public.model_prices where profile_id=profile_id_input and effective_from<=now()
    )) then blocked := true; action := b.hard_action::text; end if;
    if ratio >= 1 then blocked := true; action := b.hard_action::text; end if;
  end loop;
  return jsonb_build_object('warning',warning,'blocked',blocked,'action',action);
end;
$$;
revoke all on function public.check_model_budget(uuid,uuid) from public, anon;
grant execute on function public.check_model_budget(uuid,uuid) to authenticated;

-- Trusted gateway reservations. Only a service role can reserve and settle.
create table public.model_request_reservations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  class_id uuid not null references public.classes(id) on delete restrict,
  user_id uuid not null references public.profiles(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete restrict,
  profile_id uuid not null references public.model_profiles(id) on delete restrict,
  price_id uuid references public.model_prices(id) on delete restrict,
  reserved_tokens bigint not null check (reserved_tokens > 0),
  reserved_cost_micros bigint check (reserved_cost_micros >= 0),
  status text not null default 'reserved' check (status in ('reserved','settled')),
  created_at timestamptz not null default now()
);
create index model_request_reservations_active_idx on public.model_request_reservations(organization_id,status,created_at) where status='reserved';
alter table public.model_request_reservations enable row level security;
revoke all on public.model_request_reservations from public, anon, authenticated;

create function public.gateway_reserve_model_request(user_id_input uuid, project_id_input uuid, profile_id_input uuid,
  thinking_level_input text, input_bound_input bigint, output_bound_input bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; m record; price record; b record; used_cost bigint; used_tokens bigint; held_cost bigint; held_tokens bigint;
  reserve_cost bigint; reserve_tokens bigint; reservation_id uuid; warning boolean := false; predicted numeric;
begin
  if input_bound_input < 1 or input_bound_input > 32000 or output_bound_input < 1 or output_bound_input > 4096 then
    raise exception 'Gateway token bound invalid' using errcode='22023'; end if;
  select p.class_id,cl.organization_id into c from public.projects p join public.classes cl on cl.id=p.class_id
    join public.organizations o on o.id=cl.organization_id and o.status='active'
    where p.id=project_id_input;
  if c.organization_id is null or not exists (select 1 from public.class_members cm where cm.class_id=c.class_id and cm.user_id=user_id_input
    and cm.role='student' and cm.status='active') or not private.has_organization_entitlement(c.organization_id,'model_governance') then
    raise exception 'Managed student project required' using errcode='42501'; end if;
  select * into m from public.model_profiles where id=profile_id_input and organization_id=c.organization_id and available;
  if m.id is null or thinking_level_input is null or not thinking_level_input = any(m.allowed_thinking_levels) then
    raise exception 'Model profile or thinking level is not approved' using errcode='42501'; end if;
  -- Serializes budget decisions and settlement in this tenant.
  perform 1 from public.organizations where id=c.organization_id for update;
  select * into price from public.model_prices where profile_id=m.id and effective_from<=now() order by effective_from desc limit 1;
  reserve_tokens := input_bound_input+output_bound_input;
  if price.id is not null then
    reserve_cost := ceil((input_bound_input::numeric * greatest(price.input_micros_per_million,
      price.cache_read_micros_per_million,price.cache_write_micros_per_million) +
      output_bound_input::numeric * price.output_micros_per_million) / 1000000)::bigint;
  end if;
  for b in select * from public.organization_budgets where organization_id=c.organization_id and
    (scope='organization' or (scope='class' and class_id=c.class_id) or (scope='user' and user_id=user_id_input) or
      (scope='model' and model_profile_id=profile_id_input)) loop
    if b.monthly_cost_limit_micros is not null and price.id is null then
      return jsonb_build_object('allowed',false,'warning',true,'action',b.hard_action,'reason','price_unknown'); end if;
    select coalesce(sum(d.known_cost_micros),0),coalesce(sum(d.input_tokens+d.output_tokens+d.cache_read_tokens+d.cache_write_tokens),0)
      into used_cost,used_tokens from public.usage_daily d where d.organization_id=c.organization_id
      and d.usage_day>=date_trunc('month',now() at time zone 'UTC')::date and
      (b.scope='organization' or (b.scope='class' and d.class_id=c.class_id) or
        (b.scope='user' and d.user_id=user_id_input) or (b.scope='model' and d.model_profile_id=profile_id_input));
    select coalesce(sum(r.reserved_cost_micros),0),coalesce(sum(r.reserved_tokens),0)
      into held_cost,held_tokens from public.model_request_reservations r where r.organization_id=c.organization_id
      and r.status='reserved' and r.created_at>=date_trunc('month',now() at time zone 'UTC') and
      (b.scope='organization' or (b.scope='class' and r.class_id=c.class_id) or
        (b.scope='user' and r.user_id=user_id_input) or (b.scope='model' and r.profile_id=profile_id_input));
    predicted := greatest(case when b.monthly_cost_limit_micros is null then 0 else
      (used_cost+held_cost+coalesce(reserve_cost,0))::numeric/b.monthly_cost_limit_micros end,
      case when b.monthly_token_limit is null then 0 else
      (used_tokens+held_tokens+reserve_tokens)::numeric/b.monthly_token_limit end);
    if predicted > 1 then return jsonb_build_object('allowed',false,'warning',true,'action',b.hard_action,'reason','hard_limit'); end if;
    if predicted >= b.warning_fraction then warning := true; end if;
  end loop;
  insert into public.model_request_reservations(organization_id,class_id,user_id,project_id,profile_id,price_id,reserved_tokens,reserved_cost_micros)
    values(c.organization_id,c.class_id,user_id_input,project_id_input,profile_id_input,price.id,reserve_tokens,reserve_cost)
    returning id into reservation_id;
  return jsonb_build_object('allowed',true,'warning',warning,'reservationId',reservation_id,
    'provider',m.provider,'providerModel',m.provider_model);
end;
$$;
revoke all on function public.gateway_reserve_model_request(uuid,uuid,uuid,text,bigint,bigint) from public, anon, authenticated;
grant execute on function public.gateway_reserve_model_request(uuid,uuid,uuid,text,bigint,bigint) to service_role;

create function public.gateway_settle_model_request(reservation_id_input uuid, session_id_input uuid,
  input_tokens_input bigint, output_tokens_input bigint, cache_read_tokens_input bigint, cache_write_tokens_input bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare r record; price record; cost bigint; total_tokens bigint;
begin
  select * into r from public.model_request_reservations where id=reservation_id_input;
  if r.id is null then raise exception 'Reservation not found' using errcode='22023'; end if;
  perform 1 from public.organizations where id=r.organization_id for update;
  select * into r from public.model_request_reservations where id=reservation_id_input for update;
  if r.status='settled' then return; end if;
  if least(input_tokens_input,output_tokens_input,cache_read_tokens_input,cache_write_tokens_input) < 0 then
    raise exception 'Invalid provider usage' using errcode='22023'; end if;
  total_tokens := input_tokens_input+output_tokens_input+cache_read_tokens_input+cache_write_tokens_input;
  if total_tokens > r.reserved_tokens then raise exception 'Provider usage exceeded reservation' using errcode='23514'; end if;
  if r.price_id is not null then
    select * into price from public.model_prices where id=r.price_id;
    cost := ceil((input_tokens_input::numeric*price.input_micros_per_million+
      output_tokens_input::numeric*price.output_micros_per_million+
      cache_read_tokens_input::numeric*price.cache_read_micros_per_million+
      cache_write_tokens_input::numeric*price.cache_write_micros_per_million)/1000000)::bigint;
    if cost > r.reserved_cost_micros then raise exception 'Provider cost exceeded reservation' using errcode='23514'; end if;
  end if;
  insert into public.usage_ledger(id,organization_id,class_id,user_id,project_id,session_id,model_profile_id,provider,provider_model,
    input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost_micros,pricing_version,source,recorded_at)
    select r.id,r.organization_id,r.class_id,r.user_id,r.project_id,session_id_input,r.profile_id,m.provider,m.provider_model,
      input_tokens_input,output_tokens_input,cache_read_tokens_input,cache_write_tokens_input,cost,price.price_version,'gateway',r.created_at
    from public.model_profiles m where m.id=r.profile_id;
  update public.model_request_reservations set status='settled' where id=r.id;
end;
$$;
revoke all on function public.gateway_settle_model_request(uuid,uuid,bigint,bigint,bigint,bigint) from public, anon, authenticated;
grant execute on function public.gateway_settle_model_request(uuid,uuid,bigint,bigint,bigint,bigint) to service_role;
