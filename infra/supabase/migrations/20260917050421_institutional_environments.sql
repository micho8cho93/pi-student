-- Phase 4: immutable environment revisions, admin-only registries and scoped bindings.
-- Image building, artifact storage and secret values live outside the public schema.
create table public.sandbox_profiles (
  id uuid not null default gen_random_uuid(),
  version integer not null check (version > 0),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  runtime text not null check (runtime in ('generic','python','node')),
  runtime_version text not null check (runtime_version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$'),
  packages jsonb not null default '[]' check (jsonb_typeof(packages) = 'array' and length(packages::text) <= 16000),
  image_digest text not null check (image_digest ~ '^sha256:[a-f0-9]{64}$'),
  build_status text not null default 'pending' check (build_status in ('pending','ready','failed')),
  network_allowed boolean not null default false,
  allowed_hosts text[] not null default '{}',
  cpu_millis integer not null default 1000 check (cpu_millis between 100 and 8000),
  memory_mib integer not null default 1024 check (memory_mib between 128 and 16384),
  storage_mib integer not null default 2048 check (storage_mib between 128 and 32768),
  timeout_seconds integer not null default 120 check (timeout_seconds between 1 and 3600),
  metadata jsonb not null default '{}' check (jsonb_typeof(metadata) = 'object' and length(metadata::text) <= 4000),
  created_at timestamptz not null default now(),
  primary key (id, version), unique (organization_id, id, version),
  check (network_allowed or cardinality(allowed_hosts) = 0)
);
create index sandbox_profiles_org_idx on public.sandbox_profiles(organization_id,id,version desc);

create table public.organization_datasets (
  id uuid not null default gen_random_uuid(),
  version text not null check (version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$'),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  artifact_id text not null check (artifact_id ~ '^[a-zA-Z0-9_-]{16,128}$'),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes bigint not null check (size_bytes between 0 and 10737418240),
  scope text not null default 'organization' check (scope in ('organization','class','project')),
  class_id uuid references public.classes(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  mount_path text not null check (mount_path ~ '^/datasets/[a-zA-Z0-9_-]+(/[a-zA-Z0-9_-]+)*$' and length(mount_path) <= 160),
  access text not null default 'read-only' check (access in ('read-only','read-write')),
  created_at timestamptz not null default now(),
  primary key (id, version), unique (organization_id, id, version),
  check ((scope='organization' and class_id is null and project_id is null) or
    (scope='class' and class_id is not null and project_id is null) or
    (scope='project' and class_id is not null and project_id is not null))
);
create index organization_datasets_org_idx on public.organization_datasets(organization_id,name);
create index organization_datasets_class_idx on public.organization_datasets(class_id) where class_id is not null;
create index organization_datasets_project_idx on public.organization_datasets(project_id) where project_id is not null;
create table public.sandbox_profile_datasets (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id uuid not null,
  profile_version integer not null,
  dataset_id uuid not null,
  dataset_version text not null,
  primary key (profile_id, profile_version, dataset_id),
  foreign key (organization_id,profile_id,profile_version) references public.sandbox_profiles(organization_id,id,version) on delete cascade,
  foreign key (organization_id,dataset_id,dataset_version) references public.organization_datasets(organization_id,id,version)
);
create index sandbox_profile_datasets_artifact_idx on public.sandbox_profile_datasets(organization_id,dataset_id,dataset_version);
create table public.sandbox_profile_bindings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  scope text not null check (scope in ('organization','class','project')),
  class_id uuid references public.classes(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  profile_id uuid not null,
  profile_version integer not null,
  foreign key (organization_id,profile_id,profile_version) references public.sandbox_profiles(organization_id,id,version),
  check ((scope='organization' and class_id is null and project_id is null) or
    (scope='class' and class_id is not null and project_id is null) or
    (scope='project' and class_id is not null and project_id is not null))
);
create unique index sandbox_binding_org_unique on public.sandbox_profile_bindings(organization_id) where scope='organization';
create unique index sandbox_binding_class_unique on public.sandbox_profile_bindings(class_id) where scope='class';
create unique index sandbox_binding_project_unique on public.sandbox_profile_bindings(project_id) where scope='project';

create table public.organization_skills (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 2000),
  version text not null check (version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$'),
  artifact_digest text not null check (artifact_digest ~ '^sha256:[a-f0-9]{64}$'),
  enabled boolean not null default false,
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','rejected')),
  check (not enabled or approval_status='approved'),
  scope text not null default 'organization' check (scope in ('organization','class','project')),
  class_id uuid references public.classes(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  capabilities text[] not null default '{}',
  check (capabilities <@ array['filesystem','network','shell','github','database','external_api','secrets']::text[]),
  check ((scope='organization' and class_id is null and project_id is null) or
    (scope='class' and class_id is not null and project_id is null) or
    (scope='project' and class_id is not null and project_id is not null))
);
create table public.organization_mcps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  version text not null check (version ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,39}$'),
  transport text not null check (transport in ('http','stdio')),
  endpoint text check (endpoint ~ '^https://[a-zA-Z0-9.-]+(:[0-9]{2,5})?(/[a-zA-Z0-9_./-]*)?$' and length(endpoint) <= 500
    and endpoint !~* '^https://(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)'),
  command_artifact_digest text check (command_artifact_digest ~ '^sha256:[a-f0-9]{64}$'),
  secret_reference text check (secret_reference ~ '^vault://[a-zA-Z0-9/_-]{1,160}$'),
  allowed_hosts text[] not null default '{}',
  enabled boolean not null default false,
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','rejected')),
  check (not enabled or approval_status='approved'),
  scope text not null default 'organization' check (scope in ('organization','class','project')),
  class_id uuid references public.classes(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  capabilities text[] not null default '{}',
  check (capabilities <@ array['filesystem','network','shell','github','database','external_api','secrets']::text[]),
  check ((transport='http' and endpoint is not null and command_artifact_digest is null) or
    (transport='stdio' and endpoint is null and command_artifact_digest is not null)),
  check ((scope='organization' and class_id is null and project_id is null) or
    (scope='class' and class_id is not null and project_id is null) or
    (scope='project' and class_id is not null and project_id is not null))
);
create index organization_skills_org_idx on public.organization_skills(organization_id,name);
create index organization_skills_active_scope_idx on public.organization_skills(organization_id,scope,class_id,project_id) where enabled and approval_status='approved';
create index organization_mcps_org_idx on public.organization_mcps(organization_id,name);
create index organization_mcps_active_scope_idx on public.organization_mcps(organization_id,scope,class_id,project_id) where enabled and approval_status='approved';

-- Direct writes are never offered to clients; all mutations validate tenant targets in RPCs.
alter table public.sandbox_profiles enable row level security;
alter table public.organization_datasets enable row level security;
alter table public.sandbox_profile_datasets enable row level security;
alter table public.sandbox_profile_bindings enable row level security;
alter table public.organization_skills enable row level security;
alter table public.organization_mcps enable row level security;
revoke all on public.sandbox_profiles,public.organization_datasets,public.sandbox_profile_datasets,
  public.sandbox_profile_bindings,public.organization_skills,public.organization_mcps from public,anon,authenticated;
grant select on public.sandbox_profiles,public.organization_datasets,public.sandbox_profile_datasets,
  public.sandbox_profile_bindings,public.organization_skills,public.organization_mcps to authenticated;
create policy sandbox_profiles_admin on public.sandbox_profiles for select to authenticated using (private.can_administer_organization(organization_id));
create policy datasets_admin on public.organization_datasets for select to authenticated using (private.can_administer_organization(organization_id));
create policy profile_datasets_admin on public.sandbox_profile_datasets for select to authenticated using (private.can_administer_organization(organization_id));
create policy profile_bindings_admin on public.sandbox_profile_bindings for select to authenticated using (private.can_administer_organization(organization_id));
create policy skills_admin on public.organization_skills for select to authenticated using (private.can_administer_organization(organization_id));
create policy mcps_admin on public.organization_mcps for select to authenticated using (private.can_administer_organization(organization_id));

create function private.check_extension_scope(org_id uuid, scope_input text, class_key uuid, project_key uuid)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if scope_input not in ('organization','class','project') or
    (scope_input='organization' and (class_key is not null or project_key is not null)) or
    (scope_input='class' and (class_key is null or project_key is not null)) or
    (scope_input='project' and (class_key is null or project_key is null)) then
    raise exception 'Invalid scope' using errcode='22023'; end if;
  if class_key is not null and not exists (select 1 from public.classes where id=class_key and organization_id=org_id) then
    raise exception 'Class belongs to another organization' using errcode='42501'; end if;
  if project_key is not null and not exists (select 1 from public.projects where id=project_key and class_id=class_key) then
    raise exception 'Project belongs to another class' using errcode='42501'; end if;
end;
$$;
revoke all on function private.check_extension_scope(uuid,text,uuid,uuid) from public,anon;

create function private.audit_institutional_change() returns trigger language plpgsql security definer set search_path='' as $$
declare old_row jsonb; new_row jsonb; action_name text; target uuid; org_id uuid;
begin
  old_row := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old) end;
  new_row := case when tg_op='DELETE' then '{}'::jsonb else to_jsonb(new) end;
  target := coalesce((new_row->>'id')::uuid,(old_row->>'id')::uuid);
  org_id := coalesce((new_row->>'organization_id')::uuid,(old_row->>'organization_id')::uuid);
  action_name := case
    when tg_table_name='sandbox_profile_bindings' then 'sandbox_profile.assigned'
    when tg_table_name='sandbox_profiles' then case when tg_op='INSERT' and (new_row->>'version')::int=1 then 'sandbox_profile.created' else 'sandbox_profile.updated' end
    when tg_table_name='organization_skills' then case when tg_op='INSERT' then 'skill.imported' when (new_row->>'capabilities') is distinct from (old_row->>'capabilities') then 'extension.permission_changed' when (new_row->>'enabled')::boolean is distinct from (old_row->>'enabled')::boolean then case when (new_row->>'enabled')::boolean then 'skill.enabled' else 'skill.disabled' end else 'skill.updated' end
    when tg_table_name='organization_mcps' then case when tg_op='INSERT' then 'mcp.created' when (new_row->>'capabilities') is distinct from (old_row->>'capabilities') then 'extension.permission_changed' when (new_row->>'enabled')::boolean is distinct from (old_row->>'enabled')::boolean then case when (new_row->>'enabled')::boolean then 'mcp.enabled' else 'mcp.disabled' end else 'mcp.updated' end
    else 'dataset.created' end;
  insert into public.administrative_audit_events(actor_user_id,organization_id,action,target_type,target_id,details)
    values (auth.uid(),org_id,action_name,tg_table_name,coalesce(target::text,coalesce(new_row->>'profile_id',old_row->>'profile_id')),'{}'::jsonb);
  return case when tg_op='DELETE' then old else new end;
end;
$$;
revoke all on function private.audit_institutional_change() from public,anon,authenticated;
create trigger audit_sandbox_profiles after insert or update on public.sandbox_profiles for each row execute function private.audit_institutional_change();
create trigger audit_sandbox_bindings after insert or update on public.sandbox_profile_bindings for each row execute function private.audit_institutional_change();
create trigger audit_datasets after insert on public.organization_datasets for each row execute function private.audit_institutional_change();
create trigger audit_skills after insert or update on public.organization_skills for each row execute function private.audit_institutional_change();
create trigger audit_mcps after insert or update on public.organization_mcps for each row execute function private.audit_institutional_change();

create function public.save_sandbox_profile(org_id uuid, profile_key uuid, profile_name text, spec jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare resolved_id uuid := coalesce(profile_key,gen_random_uuid()); next_version int; pkg jsonb; host text;
begin
  if not private.can_administer_organization(org_id) then raise exception 'Organization administrator required' using errcode='42501'; end if;
  if jsonb_typeof(spec) <> 'object' or jsonb_typeof(spec->'packages') <> 'array' or
    jsonb_typeof(spec->'metadata') <> 'object' or jsonb_typeof(spec->'allowedHosts') <> 'array' or
    jsonb_array_length(spec->'packages') > 100 then raise exception 'Invalid profile specification' using errcode='22023'; end if;
  for pkg in select value from jsonb_array_elements(spec->'packages') loop
    if jsonb_typeof(pkg) <> 'object' or (pkg - array['name','version','integrity']::text[]) <> '{}'::jsonb or
      coalesce(pkg->>'name','') !~ '^[a-zA-Z0-9@/_-]{1,120}$' or
      coalesce(pkg->>'version','') !~ '^[0-9][a-zA-Z0-9._+-]{0,79}$' or
      coalesce(pkg->>'integrity','') !~ '^sha256:[a-f0-9]{64}$' then
      raise exception 'Packages require pinned versions and SHA-256 integrity' using errcode='22023'; end if;
  end loop;
  for host in select jsonb_array_elements_text(spec->'allowedHosts') loop
    if coalesce(host,'') !~ '^[a-zA-Z0-9.-]{1,253}$' or host like '%..%' then
      raise exception 'Invalid network host' using errcode='22023'; end if;
  end loop;
  if profile_key is not null and not exists (select 1 from public.sandbox_profiles where id=profile_key and organization_id=org_id) then
    raise exception 'Profile belongs to another organization' using errcode='42501'; end if;
  -- Lock the logical profile to serialize revisions. Published revisions are never edited.
  perform 1 from public.organizations where id=org_id for update;
  select coalesce(max(version),0)+1 into next_version from public.sandbox_profiles where id=resolved_id;
  insert into public.sandbox_profiles(id,version,organization_id,name,runtime,runtime_version,packages,image_digest,
    network_allowed,allowed_hosts,cpu_millis,memory_mib,storage_mib,timeout_seconds,metadata)
  values (resolved_id,next_version,org_id,profile_name,spec->>'runtime',spec->>'runtimeVersion',spec->'packages',
    spec->>'imageDigest',coalesce((spec->>'networkAllowed')::boolean,false),
    array(select jsonb_array_elements_text(spec->'allowedHosts')),
    coalesce((spec->>'cpuMillis')::int,1000),coalesce((spec->>'memoryMiB')::int,1024),
    coalesce((spec->>'storageMiB')::int,2048),coalesce((spec->>'timeoutSeconds')::int,120),spec->'metadata');
  return resolved_id;
end;
$$;
revoke all on function public.save_sandbox_profile(uuid,uuid,text,jsonb) from public,anon;
grant execute on function public.save_sandbox_profile(uuid,uuid,text,jsonb) to authenticated;

-- Only a trusted image builder can mark a verified immutable artifact ready.
create function public.mark_sandbox_profile_build(org_id uuid, profile_key uuid, revision int, status_input text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if status_input not in ('ready','failed') then raise exception 'Invalid build status' using errcode='22023'; end if;
  update public.sandbox_profiles set build_status=status_input where organization_id=org_id and id=profile_key and version=revision and build_status='pending';
  if not found then raise exception 'Pending profile not found' using errcode='22023'; end if;
end;
$$;
revoke all on function public.mark_sandbox_profile_build(uuid,uuid,int,text) from public,anon,authenticated;
grant execute on function public.mark_sandbox_profile_build(uuid,uuid,int,text) to service_role;

create function public.create_organization_dataset(org_id uuid, dataset_name text, dataset_version text,
  artifact text, digest text, bytes bigint, scope_input text, class_key uuid, project_key uuid,
  mount_input text, access_input text default 'read-only')
returns uuid language plpgsql security definer set search_path='' as $$
declare created_id uuid;
begin
  if not private.can_administer_organization(org_id) then raise exception 'Organization administrator required' using errcode='42501'; end if;
  perform private.check_extension_scope(org_id,scope_input,class_key,project_key);
  insert into public.organization_datasets(organization_id,name,version,artifact_id,sha256,size_bytes,scope,class_id,project_id,mount_path,access)
  values (org_id,dataset_name,dataset_version,artifact,digest,bytes,scope_input,class_key,project_key,mount_input,access_input)
  returning id into created_id;
  return created_id;
end;
$$;
revoke all on function public.create_organization_dataset(uuid,text,text,text,text,bigint,text,uuid,uuid,text,text) from public,anon;
grant execute on function public.create_organization_dataset(uuid,text,text,text,text,bigint,text,uuid,uuid,text,text) to authenticated;

create function public.attach_profile_dataset(org_id uuid, profile_key uuid, revision int, dataset_key uuid, dataset_revision text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.can_administer_organization(org_id) then raise exception 'Organization administrator required' using errcode='42501'; end if;
  if not exists (select 1 from public.sandbox_profiles where organization_id=org_id and id=profile_key and version=revision and build_status='pending') then
    raise exception 'Only pending profile revisions can change datasets' using errcode='42501'; end if;
  insert into public.sandbox_profile_datasets(organization_id,profile_id,profile_version,dataset_id,dataset_version)
  values (org_id,profile_key,revision,dataset_key,dataset_revision) on conflict do nothing;
end;
$$;
revoke all on function public.attach_profile_dataset(uuid,uuid,int,uuid,text) from public,anon;
grant execute on function public.attach_profile_dataset(uuid,uuid,int,uuid,text) to authenticated;

create function public.assign_sandbox_profile(org_id uuid, scope_input text, class_key uuid, project_key uuid,
  profile_key uuid, revision int)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not private.can_administer_organization(org_id) then raise exception 'Organization administrator required' using errcode='42501'; end if;
  perform private.check_extension_scope(org_id,scope_input,class_key,project_key);
  if not exists (select 1 from public.sandbox_profiles where organization_id=org_id and id=profile_key and version=revision and build_status='ready') then
    raise exception 'Only ready profiles can be assigned' using errcode='22023'; end if;
  if exists (select 1 from public.sandbox_profile_datasets link join public.organization_datasets d
      on d.organization_id=link.organization_id and d.id=link.dataset_id and d.version=link.dataset_version
      where link.profile_id=profile_key and link.profile_version=revision and
      ((d.scope='class' and (scope_input='organization' or d.class_id<>class_key)) or
       (d.scope='project' and (scope_input<>'project' or d.project_id<>project_key)))) then
    raise exception 'Dataset scope does not match profile assignment' using errcode='42501'; end if;
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

create function public.save_organization_skill(org_id uuid, skill_key uuid, name_input text, description_input text,
  version_input text, digest_input text, scope_input text, class_key uuid, project_key uuid,
  capabilities_input text[], approval_input text, enabled_input boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare resolved_id uuid;
begin
  if not private.can_administer_organization(org_id) then raise exception 'Organization administrator required' using errcode='42501'; end if;
  perform private.check_extension_scope(org_id,scope_input,class_key,project_key);
  if enabled_input and approval_input <> 'approved' then raise exception 'Approve before enabling' using errcode='22023'; end if;
  if skill_key is null then
    insert into public.organization_skills(organization_id,name,description,version,artifact_digest,scope,class_id,project_id,capabilities,approval_status,enabled)
    values (org_id,name_input,description_input,version_input,digest_input,scope_input,class_key,project_key,capabilities_input,approval_input,enabled_input)
    returning id into resolved_id;
  else
    update public.organization_skills set name=name_input,description=description_input,version=version_input,artifact_digest=digest_input,
      scope=scope_input,class_id=class_key,project_id=project_key,capabilities=capabilities_input,approval_status=approval_input,enabled=enabled_input
    where organization_id=org_id and id=skill_key returning id into resolved_id;
    if resolved_id is null then raise exception 'Skill not found' using errcode='42501'; end if;
  end if;
  return resolved_id;
end;
$$;
revoke all on function public.save_organization_skill(uuid,uuid,text,text,text,text,text,uuid,uuid,text[],text,boolean) from public,anon;
grant execute on function public.save_organization_skill(uuid,uuid,text,text,text,text,text,uuid,uuid,text[],text,boolean) to authenticated;

create function public.save_organization_mcp(org_id uuid, mcp_key uuid, name_input text, version_input text,
  transport_input text, endpoint_input text, command_digest_input text, secret_ref_input text,
  hosts_input text[], scope_input text, class_key uuid, project_key uuid, capabilities_input text[],
  approval_input text, enabled_input boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare resolved_id uuid; host text;
begin
  if not private.can_administer_organization(org_id) then raise exception 'Organization administrator required' using errcode='42501'; end if;
  perform private.check_extension_scope(org_id,scope_input,class_key,project_key);
  if enabled_input and approval_input <> 'approved' then raise exception 'Approve before enabling' using errcode='22023'; end if;
  foreach host in array hosts_input loop
    if coalesce(host,'') !~ '^[a-zA-Z0-9.-]{1,253}$' or host like '%..%' then raise exception 'Invalid host' using errcode='22023'; end if;
  end loop;
  if mcp_key is null then
    insert into public.organization_mcps(organization_id,name,version,transport,endpoint,command_artifact_digest,secret_reference,
      allowed_hosts,scope,class_id,project_id,capabilities,approval_status,enabled)
    values (org_id,name_input,version_input,transport_input,endpoint_input,command_digest_input,secret_ref_input,
      hosts_input,scope_input,class_key,project_key,capabilities_input,approval_input,enabled_input)
    returning id into resolved_id;
  else
    update public.organization_mcps set name=name_input,version=version_input,transport=transport_input,endpoint=endpoint_input,
      command_artifact_digest=command_digest_input,secret_reference=secret_ref_input,allowed_hosts=hosts_input,
      scope=scope_input,class_id=class_key,project_id=project_key,capabilities=capabilities_input,
      approval_status=approval_input,enabled=enabled_input where organization_id=org_id and id=mcp_key returning id into resolved_id;
    if resolved_id is null then raise exception 'MCP not found' using errcode='42501'; end if;
  end if;
  return resolved_id;
end;
$$;
revoke all on function public.save_organization_mcp(uuid,uuid,text,text,text,text,text,text,text[],text,uuid,uuid,text[],text,boolean) from public,anon;
grant execute on function public.save_organization_mcp(uuid,uuid,text,text,text,text,text,text,text[],text,uuid,uuid,text[],text,boolean) to authenticated;

-- One membership-checked control-plane snapshot. No secret references, credential
-- values, endpoint URLs or commands are returned to the student process.
create function public.resolve_institutional_environment(project_id_input uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org_id uuid; class_key uuid; profile_row public.sandbox_profiles%rowtype; result jsonb;
begin
  select c.organization_id,c.id into org_id,class_key
    from public.projects p join public.classes c on c.id=p.class_id where p.id=project_id_input;
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
          (s.scope='project' and s.project_id=project_id_input))),
    'mcps',(select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'organizationId',org_id,'name',m.name,
      'transport',m.transport,'version',m.version,'scope',m.scope,'capabilities',m.capabilities)),'[]'::jsonb)
      from public.organization_mcps m where m.organization_id=org_id and m.enabled and m.approval_status='approved'
        and (m.scope='organization' or (m.scope='class' and m.class_id=class_key) or
          (m.scope='project' and m.project_id=project_id_input)))
  ) into result;
  return result;
end;
$$;
revoke all on function public.resolve_institutional_environment(uuid) from public,anon;
grant execute on function public.resolve_institutional_environment(uuid) to authenticated;
