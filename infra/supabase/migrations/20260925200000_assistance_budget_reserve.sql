-- Educational budget lanes.
--
-- 1. Policy: limits.tutoringTurns reserves tutoring after the agent's session
--    turn/time limits are reached. It follows the existing hierarchy
--    (organization -> class -> project) and delegation rules. Token and cost
--    session limits stay overall limits that stop all AI.
-- 2. Monthly budgets: assistance_reserve_fraction keeps the last part of an
--    organization, class, user, or model budget for requests that cannot use
--    tools (tutoring, autocomplete, architecture maps). Usage tracking is
--    unchanged; the gateway classifies requests by whether they carry tools.

create or replace function private.validate_capability_policy(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' or p->'schemaVersion' is distinct from '1'::jsonb then return false; end if;
  if jsonb_typeof(p->'reasoningLevels') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p->'reasoningLevels') < 1 or jsonb_array_length(p->'reasoningLevels') > 7 then return false; end if;
  for v in select * from jsonb_array_elements(p->'reasoningLevels') loop
    if not (v <@ '["off","minimal","low","medium","high","xhigh","max"]'::jsonb) then return false; end if;
  end loop;
  if jsonb_typeof(p->'models') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p->'models') > 30 then return false; end if;
  for v in select * from jsonb_array_elements(p->'models') loop
    if jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 200 or (v #>> '{}') !~ '^[^[:space:]/]+/[^[:space:]]+$' then return false; end if;
  end loop;
  foreach k in array array['fileEditing','terminal','dependencyInstallation','internet','desktopExport','imageUploads','fileUploads','reflection'] loop
    if jsonb_typeof(p->k) is distinct from 'boolean' then return false; end if;
  end loop;
  foreach k in array array['dictation','cloudDictation','readAloud','simplifiedVocabulary','readableFormatting'] loop
    if jsonb_typeof(p->'accessibility'->k) is distinct from 'boolean' then return false; end if;
  end loop;
  -- tutoringTurns is optional so policies saved before it existed stay valid.
  foreach k in array array['minutes','turns','tokens','cost','tutoringTurns'] loop
    v := p->'limits'->k;
    if v is null then
      if k = 'tutoringTurns' then continue; end if;
      return false;
    end if;
    if v <> 'null'::jsonb then
      if jsonb_typeof(v) <> 'number' then return false; end if;
      if (v::text)::numeric <= 0 or (v::text)::numeric > 1000000000 then return false; end if;
      if k <> 'cost' and trunc((v::text)::numeric) <> (v::text)::numeric then return false; end if;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function public.save_governance_policy(organization_id_input uuid, scope_input public.governance_policy_scope,
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
    'models','reasoningLevels','limits.minutes','limits.turns','limits.tokens','limits.cost','limits.tutoringTurns',
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
    'imageUploads','fileUploads','reflection','models','reasoningLevels','limits.minutes','limits.turns','limits.tokens','limits.cost','limits.tutoringTurns',
    'accessibility.dictation','accessibility.cloudDictation','accessibility.readAloud','accessibility.simplifiedVocabulary','accessibility.readableFormatting']::text[]) then
    raise exception 'Invalid delegated path' using errcode='22023'; end if;
  -- Teachers may configure only paths explicitly delegated above; no further delegation.
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

create or replace function public.class_capability_context(class_id_input uuid, project_id_input uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid; settings jsonb; layer record; paths text[]; setting_path text; keys text[]; proposed jsonb; current_value jsonb; next_value jsonb;
begin
 if not private.teacher_workspace_access(class_id_input) then raise exception 'Class management required' using errcode='42501'; end if;
 select organization_id into org from public.classes where id=class_id_input;
 if project_id_input is not null and not exists(select 1 from public.projects where id=project_id_input and class_id=class_id_input) then raise exception 'Project outside class'; end if;
 settings := '{"schemaVersion":1,"reasoningLevels":["off","minimal","low","medium","high","xhigh","max"],"models":[],"fileEditing":true,"terminal":true,"dependencyInstallation":true,"internet":true,"desktopExport":true,"imageUploads":true,"fileUploads":true,"reflection":true,"limits":{"minutes":null,"turns":null,"tokens":null,"cost":null,"tutoringTurns":null},"accessibility":{"dictation":true,"cloudDictation":true,"readAloud":false,"simplifiedVocabulary":false,"readableFormatting":false}}'::jsonb;

 select delegated_paths into paths from public.governance_policies where organization_id=org and scope='organization';
 for layer in select g.settings from public.governance_policies g where g.organization_id=org and (g.scope='organization' or (g.scope='class' and g.class_id=class_id_input) or (g.scope='project' and g.project_id=project_id_input)) order by case g.scope when 'organization' then 1 when 'class' then 2 else 3 end loop
 for setting_path in select key from jsonb_object_keys(settings) key where key not in ('schemaVersion','limits','accessibility') union all select 'limits.'||key from jsonb_object_keys(settings->'limits') key union all select 'accessibility.'||key from jsonb_object_keys(settings->'accessibility') key loop
  keys:=string_to_array(setting_path,'.'); proposed:=layer.settings #> keys; current_value:=settings #> keys;
  if proposed is null or proposed='null'::jsonb then continue; end if;
  if jsonb_typeof(current_value)='boolean' then next_value:=to_jsonb((current_value::text)::boolean and (proposed::text)::boolean);
  elsif setting_path like 'limits.%' then next_value:=case when current_value='null'::jsonb then proposed else to_jsonb(least((current_value::text)::numeric,(proposed::text)::numeric)) end;
  elsif setting_path in ('models','reasoningLevels') then
   if setting_path='models' and current_value='[]'::jsonb then next_value:=proposed;
   else select coalesce(jsonb_agg(value),'[]'::jsonb) into next_value from jsonb_array_elements(current_value) where proposed @> jsonb_build_array(value); end if;
  else continue; end if;
  settings:=jsonb_set(settings,keys,next_value);
 end loop;
 end loop;
 return jsonb_build_object('settings',settings,'delegatedPaths',coalesce(paths,'{}'::text[]),'models',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'name',m.display_name) order by m.display_name) from public.model_profiles m where m.organization_id=org and m.available),'[]'::jsonb));
end $$;

alter table public.organization_budgets
  add column assistance_reserve_fraction numeric(4,3) not null default 0
    check (assistance_reserve_fraction >= 0 and assistance_reserve_fraction < 1);
comment on column public.organization_budgets.assistance_reserve_fraction is
  'Share of the monthly limit reserved for tool-free requests (tutoring, autocomplete, architecture). Agent requests stop at 1 - this fraction.';

drop function public.save_organization_budget(uuid,public.budget_scope,uuid,uuid,uuid,bigint,bigint,numeric,public.budget_hard_action);
create function public.save_organization_budget(organization_id_input uuid, scope_input public.budget_scope,
  class_id_input uuid, user_id_input uuid, model_profile_id_input uuid,
  cost_limit_input bigint, token_limit_input bigint, warning_fraction_input numeric, action_input public.budget_hard_action,
  assistance_reserve_input numeric default 0)
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
    insert into public.organization_budgets(organization_id,scope,class_id,user_id,model_profile_id,monthly_cost_limit_micros,monthly_token_limit,warning_fraction,hard_action,assistance_reserve_fraction)
      values(organization_id_input,scope_input,class_id_input,user_id_input,model_profile_id_input,cost_limit_input,token_limit_input,warning_fraction_input,action_input,assistance_reserve_input) returning id into resolved_id;
  else
    update public.organization_budgets set monthly_cost_limit_micros=cost_limit_input,monthly_token_limit=token_limit_input,
      warning_fraction=warning_fraction_input,hard_action=action_input,
      assistance_reserve_fraction=assistance_reserve_input where id=existing_id returning id into resolved_id;
  end if;
  return resolved_id;
end;
$$;
revoke all on function public.save_organization_budget(uuid,public.budget_scope,uuid,uuid,uuid,bigint,bigint,numeric,public.budget_hard_action,numeric) from public, anon;
grant execute on function public.save_organization_budget(uuid,public.budget_scope,uuid,uuid,uuid,bigint,bigint,numeric,public.budget_hard_action,numeric) to authenticated;

-- Preflight for the honest client. blocked stops all AI; agentBlocked stops only
-- tool-using requests. The gateway enforces both on the provider request.
create or replace function public.check_model_budget(project_id_input uuid, profile_id_input uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare class_key uuid; org_id uuid; spent bigint; tokens bigint; unknown_count bigint; warning boolean := false; blocked boolean := false; agent_blocked boolean := false; action text;
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
    -- The reserve admits only tool-free requests, so agent execution stops first.
    if b.assistance_reserve_fraction > 0 and ratio >= 1 - b.assistance_reserve_fraction then agent_blocked := true; warning := true; end if;
  end loop;
  return jsonb_build_object('warning',warning,'blocked',blocked,'agentBlocked',blocked or agent_blocked,'action',action);
end;
$$;

drop function public.gateway_reserve_model_request(uuid,uuid,uuid,text,bigint,bigint);
create function public.gateway_reserve_model_request(user_id_input uuid, project_id_input uuid, profile_id_input uuid,
  thinking_level_input text, input_bound_input bigint, output_bound_input bigint,
  agent_request_input boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c record; m public.model_profiles%rowtype; price public.model_prices%rowtype; b record; used_cost bigint; used_tokens bigint; unknown_count bigint; held_cost bigint; held_tokens bigint;
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
  if m.id is null or not exists (select 1 from public.organization_provider_approvals a
    where a.organization_id=c.organization_id and a.provider_id=m.provider)
    or thinking_level_input is null or not thinking_level_input = any(m.allowed_thinking_levels) then
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
    select coalesce(sum(d.known_cost_micros),0),coalesce(sum(d.input_tokens+d.output_tokens+d.cache_read_tokens+d.cache_write_tokens),0),
      coalesce(sum(d.unknown_cost_count),0)
      into used_cost,used_tokens,unknown_count from public.usage_daily d where d.organization_id=c.organization_id
      and d.usage_day>=date_trunc('month',now() at time zone 'UTC')::date and
      (b.scope='organization' or (b.scope='class' and d.class_id=c.class_id) or
        (b.scope='user' and d.user_id=user_id_input) or (b.scope='model' and d.model_profile_id=profile_id_input));
    if b.monthly_cost_limit_micros is not null and unknown_count > 0 then
      return jsonb_build_object('allowed',false,'warning',true,'action',b.hard_action,'reason','prior_cost_unknown'); end if;
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
    if agent_request_input and b.assistance_reserve_fraction > 0 and predicted > 1 - b.assistance_reserve_fraction then
      return jsonb_build_object('allowed',false,'warning',true,'action','assistance_only','reason','agent_budget_reserved'); end if;
    if predicted >= b.warning_fraction then warning := true; end if;
  end loop;
  insert into public.model_request_reservations(organization_id,class_id,user_id,project_id,profile_id,price_id,reserved_tokens,reserved_cost_micros)
    values(c.organization_id,c.class_id,user_id_input,project_id_input,profile_id_input,price.id,reserve_tokens,reserve_cost)
    returning id into reservation_id;
  return jsonb_build_object('allowed',true,'warning',warning,'reservationId',reservation_id,
    'provider',m.provider,'providerModel',m.provider_model);
end;
$$;
revoke all on function public.gateway_reserve_model_request(uuid,uuid,uuid,text,bigint,bigint,boolean) from public, anon, authenticated;
grant execute on function public.gateway_reserve_model_request(uuid,uuid,uuid,text,bigint,bigint,boolean) to service_role;

notify pgrst, 'reload schema';
