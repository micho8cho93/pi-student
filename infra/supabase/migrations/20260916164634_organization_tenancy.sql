-- Phase 1 tenancy. NULL organization_id keeps existing classrooms standalone.
create type public.organization_role as enum ('owner', 'admin', 'teacher', 'member');
create type public.organization_membership_status as enum ('active', 'suspended');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,62}$'),
  name text not null check (char_length(trim(name)) between 1 and 160),
  created_at timestamptz not null default now()
);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.organization_role not null,
  status public.organization_membership_status not null default 'active',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_memberships_user_idx on public.organization_memberships(user_id, status, organization_id);
create index organization_memberships_org_role_idx on public.organization_memberships(organization_id, status, role);

alter table public.classes add column organization_id uuid references public.organizations(id) on delete restrict;
create index classes_organization_idx on public.classes(organization_id) where organization_id is not null;
comment on column public.classes.organization_id is 'NULL for existing standalone classrooms; populated only for organization-managed classes.';
comment on column public.classes.teacher_id is 'Legacy creator attribution; tenant authorization for managed classes uses organization and class memberships.';

alter table public.organizations enable row level security;
alter table public.organization_memberships enable row level security;
revoke all on public.organizations, public.organization_memberships from public, anon, authenticated;
grant select on public.organizations, public.organization_memberships to authenticated;
grant update (name) on public.organizations to authenticated;
-- A caller cannot move an existing class between tenants or rewrite creator attribution.
revoke update on public.classes from authenticated;
grant update (name, join_enabled, join_code_expires_at) on public.classes to authenticated;

create function private.organization_role_for(organization_id_input uuid)
returns public.organization_role language sql stable security definer set search_path = '' as $$
  select m.role from public.organization_memberships m
  where m.organization_id = organization_id_input
    and m.user_id = (select auth.uid()) and m.status = 'active'
$$;

create function private.can_administer_organization(organization_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.organization_role_for(organization_id_input) in ('owner', 'admin')
$$;

create function private.can_create_organization_class(organization_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.organization_role_for(organization_id_input) in ('owner', 'admin', 'teacher')
$$;

create or replace function private.is_class_teacher(class_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.classes c
    join public.class_members cm on cm.class_id = c.id
    where c.id = class_id_input and cm.user_id = (select auth.uid())
      and cm.role = 'teacher' and cm.status = 'active'
      and (
        (c.organization_id is null and c.teacher_id = cm.user_id)
        or (c.organization_id is not null and private.organization_role_for(c.organization_id) in ('owner', 'admin', 'teacher'))
      )
  )
$$;

create function private.can_manage_class(class_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.classes c where c.id = class_id_input
      and (private.is_class_teacher(c.id)
        or (c.organization_id is not null and private.can_administer_organization(c.organization_id)))
  )
$$;

create or replace function private.is_active_class_member(class_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.class_members cm
    join public.classes c on c.id = cm.class_id
    where cm.class_id = class_id_input and cm.user_id = (select auth.uid())
      and cm.status = 'active'
      and (cm.role = 'student' or private.is_class_teacher(c.id))
  )
$$;

create or replace function private.teacher_can_read_student(class_id_input uuid, student_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_manage_class(class_id_input) and exists (
    select 1 from public.class_members cm
    where cm.class_id = class_id_input and cm.user_id = student_id_input
      and cm.role = 'student' and cm.status = 'active'
  )
$$;

-- An organization member has no implicit access to a class. A student needs a
-- class membership; a teacher needs both class and organization memberships.
revoke all on function private.organization_role_for(uuid), private.can_administer_organization(uuid),
  private.can_create_organization_class(uuid), private.can_manage_class(uuid) from public, anon;
grant execute on function private.organization_role_for(uuid), private.can_administer_organization(uuid),
  private.can_create_organization_class(uuid), private.can_manage_class(uuid) to authenticated;

create policy organizations_select on public.organizations for select to authenticated
  using (private.organization_role_for(id) is not null);
create policy organizations_update on public.organizations for update to authenticated
  using (private.can_administer_organization(id)) with check (private.can_administer_organization(id));
create policy organization_memberships_select on public.organization_memberships for select to authenticated
  using (private.can_administer_organization(organization_id)
    or (user_id = (select auth.uid()) and status = 'active'));

-- Provision the first owner atomically; ordinary clients have no table INSERT.
create function public.create_organization(slug_input text, name_input text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare created_id uuid; requester uuid := auth.uid();
begin
  if requester is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  insert into public.organizations (slug, name) values (slug_input, name_input) returning id into created_id;
  insert into public.organization_memberships (organization_id, user_id, role)
    values (created_id, requester, 'owner');
  return created_id;
end;
$$;

-- All membership mutations go through this function, so role escalation and
-- removal of the final active owner can be checked with the org row locked.
create function public.set_organization_membership(
  organization_id_input uuid, user_id_input uuid,
  role_input public.organization_role, status_input public.organization_membership_status default 'active'
) returns void language plpgsql security definer set search_path = '' as $$
declare actor_role public.organization_role; old_role public.organization_role;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = organization_id_input for update;
  if not found then raise exception 'Organization not found' using errcode = '42501'; end if;
  actor_role := private.organization_role_for(organization_id_input);
  if actor_role is null or actor_role not in ('owner', 'admin') or
    (actor_role = 'admin' and role_input in ('owner', 'admin')) then
    raise exception 'Organization administration required' using errcode = '42501';
  end if;
  select m.role into old_role from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id = user_id_input;
  if actor_role = 'admin' and old_role in ('owner', 'admin') then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  if old_role = 'owner' and (role_input <> 'owner' or status_input <> 'active') and
    not exists (select 1 from public.organization_memberships m
      where m.organization_id = organization_id_input and m.user_id <> user_id_input
        and m.role = 'owner' and m.status = 'active') then
    raise exception 'Cannot remove the final active owner' using errcode = '23514';
  end if;
  insert into public.organization_memberships (organization_id, user_id, role, status)
    values (organization_id_input, user_id_input, role_input, status_input)
    on conflict (organization_id, user_id) do update set role = excluded.role, status = excluded.status;
end;
$$;

create function public.remove_organization_membership(organization_id_input uuid, user_id_input uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare actor_role public.organization_role; old_role public.organization_role;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = organization_id_input for update;
  if not found then raise exception 'Organization not found' using errcode = '42501'; end if;
  actor_role := private.organization_role_for(organization_id_input);
  select m.role into old_role from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id = user_id_input;
  if actor_role is null or actor_role not in ('owner', 'admin') or
    (actor_role = 'admin' and old_role in ('owner', 'admin')) then
    raise exception 'Organization administration required' using errcode = '42501';
  end if;
  if old_role = 'owner' and not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id <> user_id_input
      and m.role = 'owner' and m.status = 'active'
  ) then raise exception 'Cannot remove the final active owner' using errcode = '23514'; end if;
  delete from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id = user_id_input;
end;
$$;

revoke all on function public.create_organization(text, text),
  public.set_organization_membership(uuid, uuid, public.organization_role, public.organization_membership_status),
  public.remove_organization_membership(uuid, uuid) from public, anon;
grant execute on function public.create_organization(text, text),
  public.set_organization_membership(uuid, uuid, public.organization_role, public.organization_membership_status),
  public.remove_organization_membership(uuid, uuid) to authenticated;

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid()) or exists (
    select 1 from public.class_members cm
    where cm.user_id = profiles.id and private.can_manage_class(cm.class_id)
  )
);

drop policy classes_select on public.classes;
create policy classes_select on public.classes for select to authenticated
  using (private.can_manage_class(id) or private.is_active_class_member(id));
drop policy classes_insert_teacher on public.classes;
create policy classes_insert_teacher on public.classes for insert to authenticated
  with check (teacher_id = (select auth.uid()) and
    (organization_id is null or private.can_create_organization_class(organization_id)));
drop policy classes_update_teacher on public.classes;
create policy classes_update_teacher on public.classes for update to authenticated
  using (private.can_manage_class(id)) with check (private.can_manage_class(id));
drop policy classes_delete_teacher on public.classes;
create policy classes_delete_teacher on public.classes for delete to authenticated
  using (private.can_manage_class(id));

drop policy class_members_select on public.class_members;
create policy class_members_select on public.class_members for select to authenticated using (
  private.can_manage_class(class_id) or
  (user_id = (select auth.uid()) and
    (role = 'student' or private.is_class_teacher(class_id)))
);
drop policy class_members_update_teacher on public.class_members;
create policy class_members_update_teacher on public.class_members for update to authenticated
  using (private.can_manage_class(class_id) and role = 'student')
  with check (private.can_manage_class(class_id) and role = 'student');

-- Existing project, standard, and requirement policies call is_class_teacher.
-- Recreate them with the capability helper so organization admins can manage
-- permitted classroom resources, while org membership alone reveals nothing.
do $$
declare table_name text; policy_name text;
begin
  foreach table_name in array array['projects', 'project_requirements', 'standards', 'project_standards'] loop
    for policy_name in select policyname from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = table_name loop
      execute format('drop policy %I on public.%I', policy_name, table_name);
    end loop;
  end loop;
end $$;

create policy projects_select on public.projects for select to authenticated
  using (private.can_manage_class(class_id) or private.is_active_class_member(class_id));
create policy projects_insert_teacher on public.projects for insert to authenticated
  with check (private.can_manage_class(class_id));
create policy projects_update_teacher on public.projects for update to authenticated
  using (private.can_manage_class(class_id)) with check (private.can_manage_class(class_id));
create policy projects_delete_teacher on public.projects for delete to authenticated
  using (private.can_manage_class(class_id));

create policy requirements_select on public.project_requirements for select to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and
    (private.can_manage_class(p.class_id) or private.is_active_class_member(p.class_id)))
);
create policy requirements_insert_teacher on public.project_requirements for insert to authenticated with check (
  exists (select 1 from public.projects p where p.id = project_id and private.can_manage_class(p.class_id))
);
create policy requirements_update_teacher on public.project_requirements for update to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and private.can_manage_class(p.class_id))
) with check (exists (select 1 from public.projects p where p.id = project_id and private.can_manage_class(p.class_id)));
create policy requirements_delete_teacher on public.project_requirements for delete to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and private.can_manage_class(p.class_id))
);

create policy standards_select on public.standards for select to authenticated
  using (private.can_manage_class(class_id) or private.is_active_class_member(class_id));
create policy standards_insert_teacher on public.standards for insert to authenticated with check (private.can_manage_class(class_id));
create policy standards_update_teacher on public.standards for update to authenticated
  using (private.can_manage_class(class_id)) with check (private.can_manage_class(class_id));
create policy standards_delete_teacher on public.standards for delete to authenticated using (private.can_manage_class(class_id));

create policy project_standards_select on public.project_standards for select to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and
    (private.can_manage_class(p.class_id) or private.is_active_class_member(p.class_id)))
);
create policy project_standards_insert_teacher on public.project_standards for insert to authenticated with check (
  exists (select 1 from public.projects p join public.standards s on s.class_id = p.class_id
    where p.id = project_id and s.id = standard_id and private.can_manage_class(p.class_id))
);
create policy project_standards_update_teacher on public.project_standards for update to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and private.can_manage_class(p.class_id))
) with check (exists (select 1 from public.projects p join public.standards s on s.class_id = p.class_id
  where p.id = project_id and s.id = standard_id and private.can_manage_class(p.class_id)));
create policy project_standards_delete_teacher on public.project_standards for delete to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and private.can_manage_class(p.class_id))
);

-- A recorded session cannot be moved between classes or students by UPDATE.
create function private.preserve_session_owner_and_class()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.student_id is distinct from old.student_id or new.class_id is distinct from old.class_id then
    raise exception 'Recorded session owner and class cannot change' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.preserve_session_owner_and_class() from public, anon, authenticated;
create trigger preserve_session_owner_and_class before update on public.sessions
  for each row execute function private.preserve_session_owner_and_class();
