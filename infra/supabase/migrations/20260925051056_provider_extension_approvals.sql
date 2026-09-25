-- Organization provider approvals are a closed, per-tenant allow list.
create table public.organization_provider_approvals (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_id text not null check (provider_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  approved_at timestamptz not null default now(),
  approved_by uuid references public.profiles(id),
  primary key (organization_id, provider_id)
);
alter table public.organization_provider_approvals enable row level security;
revoke all on public.organization_provider_approvals from public, anon, authenticated;
grant select on public.organization_provider_approvals to authenticated;
create policy organization_provider_admin_read on public.organization_provider_approvals
  for select to authenticated using (private.can_administer_organization(organization_id));

create function public.save_organization_providers(organization_id_input uuid, providers_input text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_administer_organization(organization_id_input)
    or not private.has_organization_entitlement(organization_id_input, 'model_governance') then
    raise exception 'Model governance required' using errcode = '42501';
  end if;
  if providers_input is null or cardinality(providers_input) > 30
    or exists (select 1 from unnest(providers_input) as p(id) where id is null or id !~ '^[a-z0-9][a-z0-9-]{0,63}$') then
    raise exception 'Invalid provider selection' using errcode = '22023';
  end if;
  delete from public.organization_provider_approvals where organization_id = organization_id_input
    and provider_id <> all(providers_input);
  insert into public.organization_provider_approvals(organization_id, provider_id, approved_by)
    select organization_id_input, id, auth.uid() from (select distinct id from unnest(providers_input) as p(id)) choices
    on conflict (organization_id, provider_id) do nothing;
  insert into public.administrative_audit_events(actor_user_id, organization_id, action, target_type, target_id, details)
    values (auth.uid(), organization_id_input, 'model.providers_updated', 'organization', organization_id_input::text,
      jsonb_build_object('providers', providers_input));
end;
$$;
revoke all on function public.save_organization_providers(uuid, text[]) from public, anon;
grant execute on function public.save_organization_providers(uuid, text[]) to authenticated;

create function public.approved_provider_ids(project_id_input uuid)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid; class_key uuid;
begin
  select c.organization_id, c.id into org_id, class_key
    from public.projects p join public.classes c on c.id = p.class_id where p.id = project_id_input;
  if org_id is null or not (private.is_active_class_member(class_key) or private.teacher_workspace_access(class_key)) then
    raise exception 'Managed project access required' using errcode = '42501';
  end if;
  return coalesce((select array_agg(provider_id order by provider_id) from public.organization_provider_approvals
    where organization_id = org_id), '{}'::text[]);
end;
$$;
revoke all on function public.approved_provider_ids(uuid) from public, anon;
grant execute on function public.approved_provider_ids(uuid) to authenticated;

-- Teacher checkboxes grant access. A new organization approval stays unavailable
-- to students until their teacher explicitly enables it for the class or project.
create table public.teacher_extension_grants (
  class_id uuid not null references public.classes(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  kind text not null check (kind in ('skill', 'mcp')),
  extension_id uuid not null,
  approved_at timestamptz not null default now(),
  approved_by uuid references public.profiles(id)
);
create unique index teacher_extension_grants_target_unique
  on public.teacher_extension_grants(class_id, project_id, kind, extension_id) nulls not distinct;
create index teacher_extension_grants_lookup
  on public.teacher_extension_grants(class_id, kind, extension_id, project_id);
alter table public.teacher_extension_grants enable row level security;
revoke all on public.teacher_extension_grants from public, anon, authenticated;

create or replace function public.teacher_extension_catalog(class_id_input uuid, project_id_input uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid; result jsonb;
begin
  if not private.teacher_workspace_access(class_id_input) then
    raise exception 'Teacher access required' using errcode = '42501';
  end if;
  select organization_id into org_id from public.classes where id = class_id_input;
  if project_id_input is not null and not exists (
    select 1 from public.projects where id = project_id_input and class_id = class_id_input
  ) then raise exception 'Project outside class' using errcode = '42501'; end if;
  if org_id is null then return '[]'::jsonb; end if;
  with eligible as (
    select 'skill'::text kind, s.id, s.name, s.description, s.version, s.scope,
      s.capabilities, s.class_id, s.project_id
    from public.organization_skills s
    where s.organization_id = org_id and s.enabled and s.approval_status = 'approved'
    union all
    select 'mcp'::text, m.id, m.name, ''::text, m.version, m.scope,
      m.capabilities, m.class_id, m.project_id
    from public.organization_mcps m
    where m.organization_id = org_id and m.enabled and m.approval_status = 'approved'
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'kind', e.kind, 'id', e.id, 'name', e.name, 'description', e.description,
    'version', e.version, 'scope', e.scope, 'capabilities', e.capabilities,
    'classGranted', exists(select 1 from public.teacher_extension_grants b
      where b.class_id = class_id_input and b.project_id is null and b.kind = e.kind and b.extension_id = e.id),
    'projectGranted', exists(select 1 from public.teacher_extension_grants b
      where b.class_id = class_id_input and b.project_id = project_id_input and b.kind = e.kind and b.extension_id = e.id)
  ) order by e.kind, e.name), '[]'::jsonb) into result
  from eligible e
  where e.scope = 'organization' or (e.scope = 'class' and e.class_id = class_id_input)
    or (project_id_input is not null and e.scope = 'project' and e.project_id = project_id_input);
  return result;
end;
$$;
revoke all on function public.teacher_extension_catalog(uuid, uuid) from public, anon;
grant execute on function public.teacher_extension_catalog(uuid, uuid) to authenticated;

create or replace function public.set_teacher_extension_enabled(
  class_id_input uuid, project_id_input uuid, kind_input text, extension_id_input uuid, enabled_input boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare org_id uuid; extension_scope text; changed_count integer;
begin
  if not private.teacher_workspace_access(class_id_input) then
    raise exception 'Teacher access required' using errcode = '42501';
  end if;
  select organization_id into org_id from public.classes where id = class_id_input;
  if org_id is null or kind_input not in ('skill', 'mcp') or enabled_input is null then
    raise exception 'Invalid extension control' using errcode = '22023';
  end if;
  if project_id_input is not null and not exists (
    select 1 from public.projects where id = project_id_input and class_id = class_id_input
  ) then raise exception 'Project outside class' using errcode = '42501'; end if;
  if kind_input = 'skill' then
    select scope into extension_scope from public.organization_skills
      where id = extension_id_input and organization_id = org_id and enabled and approval_status = 'approved'
        and (scope = 'organization' or (scope = 'class' and class_id = class_id_input)
          or (scope = 'project' and project_id = project_id_input));
  else
    select scope into extension_scope from public.organization_mcps
      where id = extension_id_input and organization_id = org_id and enabled and approval_status = 'approved'
        and (scope = 'organization' or (scope = 'class' and class_id = class_id_input)
          or (scope = 'project' and project_id = project_id_input));
  end if;
  if extension_scope is null or (extension_scope = 'project' and project_id_input is null) then
    raise exception 'Extension unavailable for this target' using errcode = '42501';
  end if;
  if not enabled_input then
    delete from public.teacher_extension_grants where class_id = class_id_input
      and project_id is not distinct from project_id_input and kind = kind_input
      and extension_id = extension_id_input;
  else
    insert into public.teacher_extension_grants(class_id, project_id, kind, extension_id, approved_by)
      values (class_id_input, project_id_input, kind_input, extension_id_input, auth.uid())
      on conflict (class_id, project_id, kind, extension_id) do nothing;
  end if;
  get diagnostics changed_count = row_count;
  if changed_count > 0 then
    insert into public.administrative_audit_events(actor_user_id, organization_id, action, target_type, target_id, details)
      values ((select auth.uid()), org_id,
        case when enabled_input then 'extension.teacher_enabled' else 'extension.teacher_disabled' end,
        kind_input, extension_id_input::text,
        jsonb_build_object('classId', class_id_input, 'projectId', project_id_input));
  end if;
end;
$$;
revoke all on function public.set_teacher_extension_enabled(uuid, uuid, text, uuid, boolean) from public, anon;
grant execute on function public.set_teacher_extension_enabled(uuid, uuid, text, uuid, boolean) to authenticated;

create or replace function public.resolve_institutional_environment(project_id_input uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org_id uuid; class_key uuid; blocked_sites text[]; profile_row public.sandbox_profiles%rowtype; result jsonb;
begin
  select c.organization_id,c.id,coalesce(o.sandbox_blocked_sites,'{}'::text[]) into org_id,class_key,blocked_sites
    from public.projects p join public.classes c on c.id=p.class_id
    left join public.organizations o on o.id=c.organization_id where p.id=project_id_input;
  if org_id is null or not private.is_active_class_member(class_key) then
    raise exception 'Managed project access required' using errcode='42501'; end if;
  select sp.* into profile_row from public.sandbox_profile_bindings b
    join public.sandbox_profiles sp on sp.organization_id=b.organization_id and sp.id=b.profile_id and sp.version=b.profile_version
    where b.organization_id=org_id and (b.scope='organization' or (b.scope='class' and b.class_id=class_key) or
      (b.scope='project' and b.project_id=project_id_input))
    order by case b.scope when 'project' then 3 when 'class' then 2 else 1 end desc limit 1;
  if profile_row.id is not null and profile_row.build_status<>'ready' then
    raise exception 'Assigned environment is not ready' using errcode='42501'; end if;
  select jsonb_build_object(
    'organizationId',org_id,'classId',class_key,'projectId',project_id_input,
    'blockedSites',to_jsonb(blocked_sites),
    'profile',case when profile_row.id is null then null else jsonb_build_object(
      'id',profile_row.id,'organizationId',org_id,'name',profile_row.name,'version',profile_row.version,
      'runtime',profile_row.runtime,'runtimeVersion',profile_row.runtime_version,'packages',profile_row.packages,
      'imageDigest',profile_row.image_digest,'buildStatus',profile_row.build_status,
      'network',jsonb_build_object('allowed',profile_row.network_allowed,'allowedHosts',profile_row.allowed_hosts),
      'limits',jsonb_build_object('cpuMillis',profile_row.cpu_millis,'memoryMiB',profile_row.memory_mib,
        'storageMiB',profile_row.storage_mib,'timeoutSeconds',profile_row.timeout_seconds),
      'metadata',profile_row.metadata,
      'datasets',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'organizationId',org_id,'name',d.name,
        'version',d.version,'sizeBytes',d.size_bytes,'artifactId',d.artifact_id,'sha256',d.sha256,
        'scope',d.scope,'classId',d.class_id,'projectId',d.project_id,'mountPath',d.mount_path,'access',d.access)),'[]'::jsonb)
        from public.sandbox_profile_datasets link join public.organization_datasets d
          on d.organization_id=link.organization_id and d.id=link.dataset_id and d.version=link.dataset_version
        where link.organization_id=org_id and link.profile_id=profile_row.id and link.profile_version=profile_row.version)
    ) end,
    'skills',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'organizationId',org_id,'name',s.name,
      'description',s.description,'version',s.version,'scope',s.scope,'capabilities',s.capabilities,
      'artifactDigest',s.artifact_digest)),'[]'::jsonb) from public.organization_skills s
      where s.organization_id=org_id and s.enabled and s.approval_status='approved'
        and (s.scope='organization' or (s.scope='class' and s.class_id=class_key) or
          (s.scope='project' and s.project_id=project_id_input))
        and exists (select 1 from public.teacher_extension_grants b where b.class_id=class_key
          and b.kind='skill' and b.extension_id=s.id and
          (b.project_id is null or b.project_id=project_id_input))),
    'mcps',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'organizationId',org_id,'name',m.name,
      'transport',m.transport,'endpoint',m.endpoint,'version',m.version,'scope',m.scope,'capabilities',m.capabilities)),'[]'::jsonb)
      from public.organization_mcps m where m.organization_id=org_id and m.enabled and m.approval_status='approved'
        and (m.scope='organization' or (m.scope='class' and m.class_id=class_key) or
          (m.scope='project' and m.project_id=project_id_input))
        and exists (select 1 from public.teacher_extension_grants b where b.class_id=class_key
          and b.kind='mcp' and b.extension_id=m.id and
          (b.project_id is null or b.project_id=project_id_input)))
  ) into result;
  return result;
end;
$$;

create or replace function public.approved_model_profiles(project_id_input uuid) returns table(
  id uuid, organization_id uuid, display_name text, provider text, provider_model text,
  allowed_thinking_levels text[], available boolean, fallback_profile_id uuid, version integer)
language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid; class_key uuid;
begin
  select c.organization_id,c.id into org_id,class_key from public.projects p join public.classes c on c.id=p.class_id where p.id=project_id_input;
  if org_id is null or not private.is_active_class_member(class_key) then raise exception 'Managed project access required' using errcode='42501'; end if;
  return query select m.id,m.organization_id,m.display_name,m.provider,m.provider_model,m.allowed_thinking_levels,m.available,m.fallback_profile_id,m.version
    from public.model_profiles m where m.organization_id=org_id and m.available and exists (select 1 from public.organization_provider_approvals a where a.organization_id=org_id and a.provider_id=m.provider) and private.has_organization_entitlement(org_id,'model_governance');
end;
$$;

-- Recheck the provider allow list at the gateway on every hosted request.
create or replace function public.gateway_reserve_model_request(user_id_input uuid, project_id_input uuid, profile_id_input uuid,
  thinking_level_input text, input_bound_input bigint, output_bound_input bigint)
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
    if predicted >= b.warning_fraction then warning := true; end if;
  end loop;
  insert into public.model_request_reservations(organization_id,class_id,user_id,project_id,profile_id,price_id,reserved_tokens,reserved_cost_micros)
    values(c.organization_id,c.class_id,user_id_input,project_id_input,profile_id_input,price.id,reserve_tokens,reserve_cost)
    returning id into reservation_id;
  return jsonb_build_object('allowed',true,'warning',warning,'reservationId',reservation_id,
    'provider',m.provider,'providerModel',m.provider_model);
end;
$$;

notify pgrst, 'reload schema';
