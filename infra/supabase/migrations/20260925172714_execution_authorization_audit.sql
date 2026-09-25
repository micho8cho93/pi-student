-- The student execution plane records only safe authorization facts. It never
-- accepts a caller-supplied user or tenant as authoritative.
create table public.execution_audit_events (
  event_id uuid primary key,
  occurred_at timestamptz not null default now(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_user_id uuid not null references public.profiles(id),
  session_id text check (session_id is null or length(session_id) between 1 and 200),
  action text not null check (action in ('skill.list','skill.read','mcp.list','mcp.call')),
  decision text not null check (decision in ('allowed','denied')),
  extension_id uuid,
  capability text check (capability is null or capability in ('filesystem','network','shell','github','database','external_api','secrets')),
  workflow_stage text check (workflow_stage is null or workflow_stage ~ '^[a-z0-9_-]{1,40}$'),
  reason_code text not null check (reason_code ~ '^[a-z0-9_.-]{1,80}$'),
  environment_provider text check (environment_provider is null or environment_provider ~ '^[a-z0-9_.-]{1,80}$'),
  environment_status text check (environment_status is null or environment_status in ('configured','unsupported','pending','building','ready','active','failed'))
);
create index execution_audit_events_org_time_idx on public.execution_audit_events(organization_id, occurred_at desc);
create index execution_audit_events_project_time_idx on public.execution_audit_events(project_id, occurred_at desc);
alter table public.execution_audit_events enable row level security;
revoke all on public.execution_audit_events from public, anon, authenticated;
grant select on public.execution_audit_events to authenticated;
create policy execution_audit_admin_read on public.execution_audit_events
  for select to authenticated using (private.can_administer_organization(organization_id));

create function public.record_execution_audit_event(
  event_id_input uuid, organization_id_input uuid, class_id_input uuid, project_id_input uuid,
  session_id_input text, action_input text, decision_input text, extension_id_input uuid,
  capability_input text, stage_input text, reason_code_input text,
  environment_provider_input text, environment_status_input text
) returns void language plpgsql security definer set search_path = '' as $$
declare derived_org uuid; derived_class uuid; actor uuid := auth.uid();
begin
  if actor is null then raise exception 'Student authentication required' using errcode = '42501'; end if;
  select c.organization_id, c.id into derived_org, derived_class
    from public.projects p join public.classes c on c.id = p.class_id
    join public.organizations o on o.id = c.organization_id and o.status = 'active'
    where p.id = project_id_input;
  if derived_org is null or derived_class is distinct from class_id_input or derived_org is distinct from organization_id_input
    or not exists (select 1 from public.class_members cm where cm.class_id = derived_class and cm.user_id = actor and cm.role = 'student' and cm.status = 'active') then
    raise exception 'Managed student project required' using errcode = '42501';
  end if;
  if event_id_input is null or action_input not in ('skill.list','skill.read','mcp.list','mcp.call')
    or decision_input not in ('allowed','denied') or reason_code_input is null
    or reason_code_input !~ '^[a-z0-9_.-]{1,80}$' then
    raise exception 'Invalid execution audit event' using errcode = '22023';
  end if;
  if extension_id_input is not null and (
    (action_input like 'skill.%' and not exists (select 1 from public.organization_skills s where s.id = extension_id_input and s.organization_id = derived_org))
    or (action_input like 'mcp.%' and not exists (select 1 from public.organization_mcps m where m.id = extension_id_input and m.organization_id = derived_org))
  ) then
    raise exception 'Extension does not belong to the active organization' using errcode = '42501';
  end if;
  insert into public.execution_audit_events(event_id, organization_id, class_id, project_id, actor_user_id,
    session_id, action, decision, extension_id, capability, workflow_stage, reason_code, environment_provider, environment_status)
  values (event_id_input, derived_org, derived_class, project_id_input, actor, session_id_input, action_input,
    decision_input, extension_id_input, capability_input, stage_input, reason_code_input,
    environment_provider_input, environment_status_input)
  on conflict (event_id) do nothing;
end;
$$;
revoke all on function public.record_execution_audit_event(uuid,uuid,uuid,uuid,text,text,text,uuid,text,text,text,text,text) from public, anon;
grant execute on function public.record_execution_audit_event(uuid,uuid,uuid,uuid,text,text,text,uuid,text,text,text,text,text) to authenticated;

-- The final teacher control path uses blocks. An older migration introduced a
-- grants table; these definitions keep the catalog and student snapshot on one
-- source of truth so teacher changes converge with runtime enforcement.
create or replace function public.teacher_extension_catalog(class_id_input uuid, project_id_input uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid; result jsonb;
begin
  if not private.teacher_workspace_access(class_id_input) then raise exception 'Teacher access required' using errcode = '42501'; end if;
  select organization_id into org_id from public.classes where id = class_id_input;
  if project_id_input is not null and not exists (select 1 from public.projects where id = project_id_input and class_id = class_id_input) then
    raise exception 'Project outside class' using errcode = '42501';
  end if;
  if org_id is null then return '[]'::jsonb; end if;
  with eligible as (
    select 'skill'::text kind, s.id, s.name, s.description, s.version, s.scope, s.capabilities, s.class_id, s.project_id
      from public.organization_skills s where s.organization_id = org_id and s.enabled and s.approval_status = 'approved'
    union all
    select 'mcp'::text, m.id, m.name, ''::text, m.version, m.scope, m.capabilities, m.class_id, m.project_id
      from public.organization_mcps m where m.organization_id = org_id and m.enabled and m.approval_status = 'approved'
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'id', e.id, 'name', e.name, 'description', e.description,
    'version', e.version, 'scope', e.scope, 'capabilities', e.capabilities,
    'classGranted', not exists(select 1 from public.teacher_extension_blocks b where b.class_id = class_id_input and b.project_id is null and b.kind = e.kind and b.extension_id = e.id),
    'projectGranted', not exists(select 1 from public.teacher_extension_blocks b where b.class_id = class_id_input and (b.project_id is null or b.project_id = project_id_input) and b.kind = e.kind and b.extension_id = e.id)) order by e.kind, e.name), '[]'::jsonb)
    into result from eligible e
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
  if not private.teacher_workspace_access(class_id_input) then raise exception 'Teacher access required' using errcode = '42501'; end if;
  select organization_id into org_id from public.classes where id = class_id_input;
  if org_id is null or kind_input not in ('skill','mcp') or enabled_input is null then raise exception 'Invalid extension control' using errcode = '22023'; end if;
  if project_id_input is not null and not exists (select 1 from public.projects where id = project_id_input and class_id = class_id_input) then raise exception 'Project outside class' using errcode = '42501'; end if;
  if kind_input = 'skill' then
    select scope into extension_scope from public.organization_skills where id = extension_id_input and organization_id = org_id and enabled and approval_status = 'approved'
      and (scope = 'organization' or (scope = 'class' and class_id = class_id_input) or (scope = 'project' and project_id = project_id_input));
  else
    select scope into extension_scope from public.organization_mcps where id = extension_id_input and organization_id = org_id and enabled and approval_status = 'approved'
      and (scope = 'organization' or (scope = 'class' and class_id = class_id_input) or (scope = 'project' and project_id = project_id_input));
  end if;
  if extension_scope is null or (extension_scope = 'project' and project_id_input is null) then raise exception 'Extension unavailable for this target' using errcode = '42501'; end if;
  if enabled_input then
    delete from public.teacher_extension_blocks where class_id = class_id_input and project_id is not distinct from project_id_input and kind = kind_input and extension_id = extension_id_input;
  else
    insert into public.teacher_extension_blocks(class_id, project_id, kind, extension_id) values (class_id_input, project_id_input, kind_input, extension_id_input)
      on conflict (class_id, project_id, kind, extension_id) do nothing;
  end if;
  get diagnostics changed_count = row_count;
  if changed_count > 0 then
    insert into public.administrative_audit_events(actor_user_id, organization_id, action, target_type, target_id, details)
      values (auth.uid(), org_id, case when enabled_input then 'extension.teacher_enabled' else 'extension.teacher_disabled' end,
        kind_input, extension_id_input::text, jsonb_build_object('classId', class_id_input, 'projectId', project_id_input));
  end if;
end;
$$;
revoke all on function public.set_teacher_extension_enabled(uuid, uuid, text, uuid, boolean) from public, anon;
grant execute on function public.set_teacher_extension_enabled(uuid, uuid, text, uuid, boolean) to authenticated;

-- Return the safe, fresh execution snapshot. Endpoint and host allowlists are
-- public connector metadata; secret references and command artifacts stay out.
create or replace function public.resolve_institutional_environment(project_id_input uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid; class_key uuid; blocked_sites text[]; profile_row public.sandbox_profiles%rowtype; result jsonb; required text[];
begin
  select c.organization_id, c.id, coalesce(o.sandbox_blocked_sites, '{}'::text[]) into org_id, class_key, blocked_sites
    from public.projects p join public.classes c on c.id = p.class_id left join public.organizations o on o.id = c.organization_id where p.id = project_id_input;
  if org_id is null or not private.is_active_class_member(class_key) then raise exception 'Managed project access required' using errcode = '42501'; end if;
  select sp.* into profile_row from public.sandbox_profile_bindings b
    join public.sandbox_profiles sp on sp.organization_id = b.organization_id and sp.id = b.profile_id and sp.version = b.profile_version
    where b.organization_id = org_id and (b.scope = 'organization' or (b.scope = 'class' and b.class_id = class_key) or (b.scope = 'project' and b.project_id = project_id_input))
    order by case b.scope when 'project' then 3 when 'class' then 2 else 1 end desc limit 1;
  required := case when profile_row.id is null then array['workspace']::text[] else array['workspace','managed-profile','profile-image','resource-limits']::text[] end;
  if profile_row.id is not null and exists (select 1 from public.sandbox_profile_datasets link where link.organization_id = org_id and link.profile_id = profile_row.id and link.profile_version = profile_row.version) then required := array_append(required, 'datasets'); end if;
  select jsonb_build_object('organizationId', org_id, 'classId', class_key, 'projectId', project_id_input,
    'environmentStatus', case when profile_row.id is null then 'configured' else profile_row.build_status end,
    'requiredCapabilities', to_jsonb(required), 'blockedSites', to_jsonb(blocked_sites),
    'profile', case when profile_row.id is null then null else jsonb_build_object('id', profile_row.id, 'organizationId', org_id, 'name', profile_row.name, 'version', profile_row.version,
      'runtime', profile_row.runtime, 'runtimeVersion', profile_row.runtime_version, 'packages', profile_row.packages, 'imageDigest', profile_row.image_digest, 'buildStatus', profile_row.build_status,
      'network', jsonb_build_object('allowed', profile_row.network_allowed, 'allowedHosts', profile_row.allowed_hosts),
      'limits', jsonb_build_object('cpuMillis', profile_row.cpu_millis, 'memoryMiB', profile_row.memory_mib, 'storageMiB', profile_row.storage_mib, 'timeoutSeconds', profile_row.timeout_seconds),
      'metadata', profile_row.metadata,
      'datasets', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'organizationId', org_id, 'name', d.name, 'version', d.version, 'sizeBytes', d.size_bytes, 'artifactId', d.artifact_id, 'sha256', d.sha256,
        'scope', d.scope, 'classId', d.class_id, 'projectId', d.project_id, 'mountPath', d.mount_path, 'access', d.access)), '[]'::jsonb)
        from public.sandbox_profile_datasets link join public.organization_datasets d on d.organization_id = link.organization_id and d.id = link.dataset_id and d.version = link.dataset_version
        where link.organization_id = org_id and link.profile_id = profile_row.id and link.profile_version = profile_row.version)) end,
    'skills', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'organizationId', org_id, 'classId', s.class_id, 'projectId', s.project_id, 'name', s.name, 'description', s.description, 'version', s.version,
      'scope', s.scope, 'capabilities', s.capabilities, 'artifactDigest', s.artifact_digest, 'enabled', s.enabled, 'approvalStatus', s.approval_status)), '[]'::jsonb)
      from public.organization_skills s where s.organization_id = org_id and s.enabled and s.approval_status = 'approved'
        and (s.scope = 'organization' or (s.scope = 'class' and s.class_id = class_key) or (s.scope = 'project' and s.project_id = project_id_input))
        and not exists (select 1 from public.teacher_extension_blocks b where b.class_id = class_key and b.kind = 'skill' and b.extension_id = s.id and (b.project_id is null or b.project_id = project_id_input))),
    'mcps', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'organizationId', org_id, 'classId', m.class_id, 'projectId', m.project_id, 'name', m.name, 'transport', m.transport, 'endpoint', m.endpoint,
      'version', m.version, 'scope', m.scope, 'capabilities', m.capabilities, 'allowedHosts', m.allowed_hosts, 'enabled', m.enabled, 'approvalStatus', m.approval_status)), '[]'::jsonb)
      from public.organization_mcps m where m.organization_id = org_id and m.enabled and m.approval_status = 'approved'
        and (m.scope = 'organization' or (m.scope = 'class' and m.class_id = class_key) or (m.scope = 'project' and m.project_id = project_id_input))
        and not exists (select 1 from public.teacher_extension_blocks b where b.class_id = class_key and b.kind = 'mcp' and b.extension_id = m.id and (b.project_id is null or b.project_id = project_id_input)))) into result;
  return result;
end;
$$;
revoke all on function public.resolve_institutional_environment(uuid) from public, anon;
grant execute on function public.resolve_institutional_environment(uuid) to authenticated;

-- The earlier grants table was never part of the final runtime snapshot. Drop
-- it after replacing every dependent RPC so one teacher-control source remains.
drop table if exists public.teacher_extension_grants;

notify pgrst, 'reload schema';
