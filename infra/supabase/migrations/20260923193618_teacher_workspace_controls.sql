-- Teachers may narrow an approved organization extension for a class or project.
-- A class block applies to every project in that class; a project block applies
-- only to that project. Organization approval and capability checks still apply.
create table public.teacher_extension_blocks (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  kind text not null check (kind in ('skill', 'mcp')),
  extension_id uuid not null,
  created_at timestamptz not null default now()
);
create unique index teacher_extension_blocks_target_unique
  on public.teacher_extension_blocks(class_id, project_id, kind, extension_id) nulls not distinct;
create index teacher_extension_blocks_lookup
  on public.teacher_extension_blocks(class_id, kind, extension_id, project_id);
alter table public.teacher_extension_blocks enable row level security;
revoke all on public.teacher_extension_blocks from public, anon, authenticated;

create function private.teacher_workspace_access(class_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_class_teacher(class_id_input)
    and private.class_workspace_active(class_id_input)
    and exists (select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.account_deleted_at is null)
$$;
revoke all on function private.teacher_workspace_access(uuid) from public, anon, authenticated;

create function public.teacher_extension_catalog(class_id_input uuid, project_id_input uuid default null)
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
    'classBlocked', exists(select 1 from public.teacher_extension_blocks b
      where b.class_id = class_id_input and b.project_id is null and b.kind = e.kind and b.extension_id = e.id),
    'projectBlocked', exists(select 1 from public.teacher_extension_blocks b
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

create function public.set_teacher_extension_enabled(
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
  if enabled_input then
    delete from public.teacher_extension_blocks where class_id = class_id_input
      and project_id is not distinct from project_id_input and kind = kind_input
      and extension_id = extension_id_input;
  else
    insert into public.teacher_extension_blocks(class_id, project_id, kind, extension_id)
      values (class_id_input, project_id_input, kind_input, extension_id_input)
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

create function public.teacher_usage_summary(class_id_input uuid, project_id_input uuid, from_day_input date)
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
  if from_day_input is null or from_day_input < current_date - 365 or from_day_input > current_date then
    raise exception 'Invalid usage range' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'sessions', count(*), 'students', count(distinct s.student_id),
    'tokens', coalesce(sum(s.total_tokens), 0),
    'minutes', coalesce(round(sum(s.duration_seconds)::numeric / 60), 0)
  ) into result from public.sessions s
    where s.class_id = class_id_input and (project_id_input is null or s.project_id = project_id_input)
      and s.started_at >= from_day_input::timestamptz
      and private.teacher_can_read_student(s.class_id, s.student_id);
  if org_id is not null then
    result := result || (
      select jsonb_build_object('knownCostMicros', coalesce(sum(d.known_cost_micros), 0),
        'unknownCostCount', coalesce(sum(d.unknown_cost_count), 0))
      from public.usage_daily d where d.organization_id = org_id and d.class_id = class_id_input
        and (project_id_input is null or d.project_id = project_id_input)
        and d.usage_day >= from_day_input
        and private.teacher_can_read_student(d.class_id, d.user_id)
    );
  end if;
  return result;
end;
$$;
revoke all on function public.teacher_usage_summary(uuid, uuid, date) from public, anon;
grant execute on function public.teacher_usage_summary(uuid, uuid, date) to authenticated;

-- Keep the existing membership and sandbox checks, then remove teacher-blocked
-- descriptors before they reach the student's resolved environment.
create or replace function public.resolve_institutional_environment(project_id_input uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare org_id uuid; class_key uuid; profile_row public.sandbox_profiles%rowtype; result jsonb;
begin
  select c.organization_id, c.id into org_id, class_key
    from public.projects p join public.classes c on c.id = p.class_id where p.id = project_id_input;
  if org_id is null or not private.is_active_class_member(class_key) then
    raise exception 'Managed project access required' using errcode = '42501'; end if;
  select sp.* into profile_row from public.sandbox_profile_bindings b
    join public.sandbox_profiles sp on sp.organization_id = b.organization_id and sp.id = b.profile_id and sp.version = b.profile_version
    where b.organization_id = org_id and (b.scope = 'organization' or (b.scope = 'class' and b.class_id = class_key) or
      (b.scope = 'project' and b.project_id = project_id_input))
    order by case b.scope when 'project' then 3 when 'class' then 2 else 1 end desc limit 1;
  if profile_row.id is not null and profile_row.build_status <> 'ready' then
    raise exception 'Assigned environment is not ready' using errcode = '42501'; end if;
  select jsonb_build_object(
    'organizationId', org_id, 'classId', class_key, 'projectId', project_id_input,
    'profile', case when profile_row.id is null then null else jsonb_build_object(
      'id',profile_row.id,'organizationId',org_id,'name',profile_row.name,'version',profile_row.version,
      'runtime',profile_row.runtime,'runtimeVersion',profile_row.runtime_version,'packages',profile_row.packages,
      'imageDigest',profile_row.image_digest,'buildStatus',profile_row.build_status,
      'network',jsonb_build_object('allowed',profile_row.network_allowed,'allowedHosts',profile_row.allowed_hosts),
      'limits',jsonb_build_object('cpuMillis',profile_row.cpu_millis,'memoryMiB',profile_row.memory_mib,
        'storageMiB',profile_row.storage_mib,'timeoutSeconds',profile_row.timeout_seconds),
      'metadata',profile_row.metadata,
      'datasets',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'organizationId',org_id,'name',d.name,
        'version',d.version,'sizeBytes',d.size_bytes,'artifactId',d.artifact_id,'sha256',d.sha256,
        'scope',d.scope,'classId',d.class_id,'projectId',d.project_id,'mountPath',d.mount_path,'access',d.access)), '[]'::jsonb)
        from public.sandbox_profile_datasets link join public.organization_datasets d
          on d.organization_id = link.organization_id and d.id = link.dataset_id and d.version = link.dataset_version
        where link.organization_id = org_id and link.profile_id = profile_row.id and link.profile_version = profile_row.version)
    ) end,
    'skills',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'organizationId',org_id,'name',s.name,
      'description',s.description,'version',s.version,'scope',s.scope,'capabilities',s.capabilities,
      'artifactDigest',s.artifact_digest)), '[]'::jsonb) from public.organization_skills s
      where s.organization_id = org_id and s.enabled and s.approval_status = 'approved'
        and (s.scope = 'organization' or (s.scope = 'class' and s.class_id = class_key) or
          (s.scope = 'project' and s.project_id = project_id_input))
        and not exists (select 1 from public.teacher_extension_blocks b where b.class_id = class_key
          and b.kind = 'skill' and b.extension_id = s.id and
          (b.project_id is null or b.project_id = project_id_input))),
    'mcps',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'organizationId',org_id,'name',m.name,
      'transport',m.transport,'version',m.version,'scope',m.scope,'capabilities',m.capabilities)), '[]'::jsonb)
      from public.organization_mcps m where m.organization_id = org_id and m.enabled and m.approval_status = 'approved'
        and (m.scope = 'organization' or (m.scope = 'class' and m.class_id = class_key) or
          (m.scope = 'project' and m.project_id = project_id_input))
        and not exists (select 1 from public.teacher_extension_blocks b where b.class_id = class_key
          and b.kind = 'mcp' and b.extension_id = m.id and
          (b.project_id is null or b.project_id = project_id_input)))
  ) into result;
  return result;
end;
$$;
