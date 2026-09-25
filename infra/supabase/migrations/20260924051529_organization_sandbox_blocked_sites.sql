-- Organization level deny list for sites reached through the Gondolin HTTP proxy.
alter table public.organizations
  add column sandbox_blocked_sites text[] not null default '{}';

create function private.valid_sandbox_blocked_sites(sites text[])
returns boolean language sql immutable set search_path = '' as $$
  select sites is not null and cardinality(sites) <= 500
    and coalesce((select bool_and(site is not null and site = lower(site) and length(site) between 3 and 253
      and site ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$')
      from unnest(sites) as entries(site)), true)
    and cardinality(sites) = (select count(distinct site) from unnest(sites) as entries(site))
$$;
revoke all on function private.valid_sandbox_blocked_sites(text[]) from public, anon, authenticated;
alter table public.organizations add constraint valid_sandbox_blocked_sites
  check (private.valid_sandbox_blocked_sites(sandbox_blocked_sites));

create function public.save_organization_sandbox_blocked_sites(organization_id_input uuid, blocked_sites_input text[])
returns void language plpgsql security definer set search_path = '' as $$
declare normalized_sites text[];
begin
  if not private.can_administer_organization(organization_id_input) then
    raise exception 'Organization administrator required' using errcode = '42501';
  end if;
  if blocked_sites_input is null or cardinality(blocked_sites_input) > 500 or exists (
    select 1 from unnest(blocked_sites_input) as entries(site) where site is null or length(btrim(site)) = 0
  ) then raise exception 'Invalid sandbox blocked sites' using errcode = '22023'; end if;

  select coalesce(array_agg(distinct lower(btrim(site)) order by lower(btrim(site))), '{}'::text[])
    into normalized_sites from unnest(blocked_sites_input) as entries(site);
  if not private.valid_sandbox_blocked_sites(normalized_sites) then
    raise exception 'Blocked sites must be valid hostnames' using errcode = '22023';
  end if;

  update public.organizations set sandbox_blocked_sites = normalized_sites where id = organization_id_input;
  if not found then raise exception 'Organization not found' using errcode = '22023'; end if;
end;
$$;
revoke all on function public.save_organization_sandbox_blocked_sites(uuid, text[]) from public, anon;
grant execute on function public.save_organization_sandbox_blocked_sites(uuid, text[]) to authenticated;

-- Extend the existing membership-checked snapshot with the organization's site deny list.
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
        and not exists (select 1 from public.teacher_extension_blocks b where b.class_id=class_key
          and b.kind='skill' and b.extension_id=s.id and
          (b.project_id is null or b.project_id=project_id_input))),
    'mcps',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'organizationId',org_id,'name',m.name,
      'transport',m.transport,'version',m.version,'scope',m.scope,'capabilities',m.capabilities)),'[]'::jsonb)
      from public.organization_mcps m where m.organization_id=org_id and m.enabled and m.approval_status='approved'
        and (m.scope='organization' or (m.scope='class' and m.class_id=class_key) or
          (m.scope='project' and m.project_id=project_id_input))
        and not exists (select 1 from public.teacher_extension_blocks b where b.class_id=class_key
          and b.kind='mcp' and b.extension_id=m.id and
          (b.project_id is null or b.project_id=project_id_input)))
  ) into result;
  return result;
end;
$$;

notify pgrst, 'reload schema';
