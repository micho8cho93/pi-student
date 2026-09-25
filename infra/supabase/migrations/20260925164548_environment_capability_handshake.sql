-- Environment state is control-plane state, not proof that a local runtime is
-- enforcing the policy. A client may only report active after its provider
-- capability handshake succeeds and the sandbox is running.
alter table public.sandbox_profiles drop constraint if exists sandbox_profiles_build_status_check;
alter table public.sandbox_profiles add constraint sandbox_profiles_build_status_check
  check (build_status in ('pending','building','ready','failed'));

-- Profile host allowlists are control-plane input too. Keep them canonical and
-- hostname-only so an adapter cannot receive a URL, port, path, or lookalike.
create or replace function private.valid_sandbox_profile_hosts(hosts text[])
returns boolean language sql immutable set search_path = '' as $$
  select hosts is not null and cardinality(hosts) <= 500
    and coalesce((select bool_and(host is not null and host = lower(host) and length(host) between 3 and 253
      and host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$')
      from unnest(hosts) as entries(host)), true)
    and cardinality(hosts) = (select count(distinct host) from unnest(hosts) as entries(host));
$$;
revoke all on function private.valid_sandbox_profile_hosts(text[]) from public, anon, authenticated;
alter table public.sandbox_profiles add constraint valid_sandbox_profile_hosts
  check (private.valid_sandbox_profile_hosts(allowed_hosts)) not valid;

create or replace function public.mark_sandbox_profile_build(org_id uuid, profile_key uuid, revision int, status_input text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if status_input not in ('building','ready','failed') then
    raise exception 'Invalid build status' using errcode='22023';
  end if;
  update public.sandbox_profiles set build_status=status_input
    where organization_id=org_id and id=profile_key and version=revision and build_status in ('pending','building');
  if not found then raise exception 'Pending profile not found' using errcode='22023'; end if;
end;
$$;
revoke all on function public.mark_sandbox_profile_build(uuid,uuid,int,text) from public,anon,authenticated;
grant execute on function public.mark_sandbox_profile_build(uuid,uuid,int,text) to service_role;

create or replace function public.assign_sandbox_profile(org_id uuid, scope_input text, class_key uuid, project_key uuid,
  profile_key uuid, revision int)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.can_administer_organization(org_id) then raise exception 'Organization administrator required' using errcode='42501'; end if;
  perform private.check_extension_scope(org_id,scope_input,class_key,project_key);
  if not exists (select 1 from public.sandbox_profiles where organization_id=org_id and id=profile_key and version=revision
      and build_status in ('pending','building','ready')) then
    raise exception 'Profile is not assignable in its current state' using errcode='22023';
  end if;
  if exists (select 1 from public.sandbox_profile_datasets link join public.organization_datasets d
      on d.organization_id=link.organization_id and d.id=link.dataset_id and d.version=link.dataset_version
      where link.organization_id=org_id and link.profile_id=profile_key and link.profile_version=revision and
      ((d.scope='class' and (scope_input='organization' or d.class_id<>class_key)) or
       (d.scope='project' and (scope_input<>'project' or d.project_id<>project_key)))) then
    raise exception 'Dataset scope does not match profile assignment' using errcode='42501';
  end if;
  update public.sandbox_profile_bindings set profile_id=profile_key,profile_version=revision
  where organization_id=org_id and scope=scope_input and class_id is not distinct from class_key and project_id is not distinct from project_key;
  if not found then
    insert into public.sandbox_profile_bindings(organization_id,scope,class_id,project_id,profile_id,profile_version)
    values (org_id,scope_input,class_key,project_key,profile_key,revision);
  end if;
end;
$$;
revoke all on function public.assign_sandbox_profile(uuid,text,uuid,uuid,uuid,int) from public,anon;
grant execute on function public.assign_sandbox_profile(uuid,text,uuid,uuid,uuid,int) to authenticated;

-- Return the assigned profile even while it is pending, building, or failed so
-- clients can show a truthful state instead of treating every non-ready state
-- as an authorization failure. The RPC still performs membership and tenant
-- checks and never exposes artifact credentials.
create or replace function public.resolve_institutional_environment(project_id_input uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org_id uuid; class_key uuid; blocked_sites text[]; profile_row public.sandbox_profiles%rowtype; result jsonb; required text[];
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
  required := case when profile_row.id is null then array['workspace']::text[]
    else array['workspace','managed-profile','profile-image','resource-limits']::text[] end;
  if profile_row.id is not null and exists (
    select 1 from public.sandbox_profile_datasets link
    where link.organization_id=org_id and link.profile_id=profile_row.id and link.profile_version=profile_row.version
  ) then required := array_append(required,'datasets'); end if;
  select jsonb_build_object(
    'organizationId',org_id,'classId',class_key,'projectId',project_id_input,
    'environmentStatus',case when profile_row.id is null then 'configured' else profile_row.build_status end,
    'requiredCapabilities',to_jsonb(required),
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
        and not exists (select 1 from public.teacher_extension_blocks b where b.class_id=class_key
          and b.kind='skill' and b.extension_id=s.id and (b.project_id is null or b.project_id=project_id_input))),
    'mcps',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'organizationId',org_id,'name',m.name,
      'transport',m.transport,'version',m.version,'scope',m.scope,'capabilities',m.capabilities)),'[]'::jsonb)
      from public.organization_mcps m where m.organization_id=org_id and m.enabled and m.approval_status='approved'
        and (m.scope='organization' or (m.scope='class' and m.class_id=class_key) or
          (m.scope='project' and m.project_id=project_id_input))
        and not exists (select 1 from public.teacher_extension_blocks b where b.class_id=class_key
          and b.kind='mcp' and b.extension_id=m.id and (b.project_id is null or b.project_id=project_id_input)))
  ) into result;
  return result;
end;
$$;
revoke all on function public.resolve_institutional_environment(uuid) from public,anon;
grant execute on function public.resolve_institutional_environment(uuid) to authenticated;

notify pgrst, 'reload schema';
