-- Organization-owned workspace preferences and permanent, data-preserving closure.
alter table public.organizations
  add column contact_email text check (contact_email is null or
    (char_length(contact_email) between 3 and 320 and position('@' in contact_email) > 1)),
  add column teachers_can_create_classes boolean not null default true,
  add column students_can_join_by_code boolean not null default true,
  add column deactivated_at timestamptz;

grant update (contact_email, teachers_can_create_classes, students_can_join_by_code)
  on public.organizations to authenticated;

create or replace function private.organization_role_for(organization_id_input uuid)
returns public.organization_role language sql stable security definer set search_path = '' as $$
  select m.role from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = organization_id_input and o.status = 'active'
    and o.deactivated_at is null
    and m.user_id = (select auth.uid()) and m.status = 'active'
$$;

create or replace function private.can_create_organization_class(organization_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_administer_organization(organization_id_input) or exists (
    select 1 from public.organizations o where o.id = organization_id_input
      and o.teachers_can_create_classes
      and private.organization_role_for(organization_id_input) = 'teacher'
  )
$$;

-- Lock the organization while adding a managed class or class membership. This
-- serializes new links with deactivation, which removes all existing links.
create function private.require_active_managed_class()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.organization_id is not null then
    perform 1 from public.organizations o where o.id = new.organization_id
      and o.status = 'active' and o.deactivated_at is null for share;
    if not found then raise exception 'Organization is inactive' using errcode = '42501'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.require_active_managed_class() from public, anon, authenticated;
create trigger require_active_managed_class before insert or update of organization_id on public.classes
  for each row execute function private.require_active_managed_class();

create function private.require_active_managed_class_membership()
returns trigger language plpgsql security definer set search_path = '' as $$
declare org_id uuid;
begin
  select c.organization_id into org_id from public.classes c where c.id = new.class_id;
  if org_id is not null then
    perform 1 from public.organizations o where o.id = org_id
      and o.status = 'active' and o.deactivated_at is null for share;
    if not found then raise exception 'Organization is inactive' using errcode = '42501'; end if;
  end if;
  return new;
end;
$$;
revoke all on function private.require_active_managed_class_membership() from public, anon, authenticated;
create trigger require_active_managed_class_membership before insert or update on public.class_members
  for each row execute function private.require_active_managed_class_membership();

create or replace function private.require_membership_entitlement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare org_id uuid;
begin
  org_id := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
  if tg_op <> 'DELETE' then
    perform 1 from public.organizations o where o.id = org_id and o.deactivated_at is null for share;
    if not found then raise exception 'Organization has been deactivated' using errcode = '42501'; end if;
  end if;
  if auth.uid() is not null and not private.is_platform_administrator()
    and not private.has_organization_entitlement(org_id, 'organization_admin') then
    raise exception 'Organization administration entitlement required' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function private.is_active_class_member(class_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.class_members cm
    join public.classes c on c.id = cm.class_id
    left join public.organizations o on o.id = c.organization_id
    where cm.class_id = class_id_input and cm.user_id = (select auth.uid())
      and cm.status = 'active'
      and (c.organization_id is null or (o.status = 'active' and o.deactivated_at is null))
      and (cm.role = 'student' or private.is_class_teacher(c.id))
  )
$$;

create function private.class_workspace_active(class_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.classes c left join public.organizations o on o.id = c.organization_id
    where c.id = class_id_input and
      (c.organization_id is null or (o.status = 'active' and o.deactivated_at is null))
  )
$$;
revoke all on function private.class_workspace_active(uuid) from public, anon;
grant execute on function private.class_workspace_active(uuid) to authenticated;

drop policy class_members_select on public.class_members;
create policy class_members_select on public.class_members for select to authenticated using (
  private.can_manage_class(class_id) or
  (user_id = (select auth.uid()) and
    private.class_workspace_active(class_id)
    and (role = 'student' or private.is_class_teacher(class_id)))
);

-- Students normally retain their own history after leaving an active class.
-- A deactivated organization is different: its retained history is inaccessible.
drop policy sessions_select on public.sessions;
create policy sessions_select on public.sessions for select to authenticated using (
  private.class_workspace_active(class_id) and
  (student_id = (select auth.uid()) or private.teacher_can_read_student(class_id, student_id))
);
drop policy sessions_update_self on public.sessions;
create policy sessions_update_self on public.sessions for update to authenticated using (
  student_id = (select auth.uid()) and private.class_workspace_active(class_id)
) with check (
  student_id = (select auth.uid()) and private.is_active_class_member(class_id)
  and (project_id is null or exists (
    select 1 from public.projects p where p.id = project_id and p.class_id = class_id))
);

create or replace function public.join_class(join_code_input text)
returns table (class_id uuid, membership_status public.membership_status)
language plpgsql security definer set search_path = '' as $$
declare requester uuid := auth.uid(); target_class uuid; target_org uuid;
begin
  if requester is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requester::text, 0));
  delete from private.join_attempts where requester_id = requester and attempted_at <= now() - interval '1 day';
  if (select count(*) from private.join_attempts where requester_id = requester and attempted_at > now() - interval '15 minutes') >= 10 then
    raise exception 'Too many join attempts. Try again later.' using errcode = 'P0001';
  end if;
  select c.id, c.organization_id into target_class, target_org from public.classes c
  where c.join_code = upper(trim(join_code_input)) and c.join_enabled
    and (c.join_code_expires_at is null or c.join_code_expires_at > now());
  if target_org is not null then
    perform 1 from public.organizations o where o.id = target_org and o.status = 'active'
      and o.deactivated_at is null and o.students_can_join_by_code for share;
    if not found then target_class := null; end if;
  end if;
  insert into private.join_attempts (requester_id, successful) values (requester, target_class is not null);
  if target_class is null then return; end if;
  insert into public.class_members as cm (class_id, user_id, role, status)
    values (target_class, requester, 'student', 'pending')
    on conflict on constraint class_members_class_id_user_id_key do update
      set status = case when cm.status = 'rejected' then 'pending' else cm.status end;
  return query select cm.class_id, cm.status from public.class_members cm
    where cm.class_id = target_class and cm.user_id = requester;
end;
$$;

-- The phrase and final checkbox are checked again in the database. Only an
-- active owner may close a workspace. Organization and classroom records stay.
create function public.deactivate_organization(
  organization_id_input uuid, confirmation_phrase_input text, confirmed_input boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare org_name text; removed_class_members bigint; removed_org_members bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select o.name into org_name from public.organizations o
    where o.id = organization_id_input and o.status = 'active' and o.deactivated_at is null for update;
  if not found then raise exception 'Active organization required' using errcode = '42501'; end if;
  if private.organization_role_for(organization_id_input) is distinct from 'owner' then
    raise exception 'Organization owner required' using errcode = '42501';
  end if;
  if confirmation_phrase_input is distinct from 'I confirm that I am deleting ' || org_name
    or confirmed_input is distinct from true then
    raise exception 'Deletion confirmation does not match' using errcode = '22023';
  end if;

  update public.organizations set status = 'suspended', deactivated_at = now()
    where id = organization_id_input;
  delete from public.class_members cm using public.classes c
    where cm.class_id = c.id and c.organization_id = organization_id_input;
  get diagnostics removed_class_members = row_count;
  delete from public.organization_memberships where organization_id = organization_id_input;
  get diagnostics removed_org_members = row_count;
  insert into public.administrative_audit_events
    (actor_user_id, organization_id, action, target_type, target_id, details)
    values (auth.uid(), organization_id_input, 'organization.deactivated', 'organization', organization_id_input::text,
      jsonb_build_object('class_memberships_removed', removed_class_members,
        'organization_memberships_removed', removed_org_members));
end;
$$;
revoke all on function public.deactivate_organization(uuid, text, boolean) from public, anon;
grant execute on function public.deactivate_organization(uuid, text, boolean) to authenticated;

-- Platform suspension remains reversible; owner deactivation does not.
create or replace function public.platform_update_organization(
  organization_id_input uuid, name_input text, status_input public.organization_status
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_administrator() then
    raise exception 'Platform administration required' using errcode = '42501'; end if;
  update public.organizations set name = name_input, status = status_input
    where id = organization_id_input and deactivated_at is null;
  if not found then raise exception 'Organization not found or deactivated' using errcode = '22023'; end if;
end;
$$;

create or replace function public.set_organization_entitlement(
  organization_id_input uuid, capability_input public.organization_entitlement_key, enabled_input boolean
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_administrator() then
    raise exception 'Platform administration required' using errcode = '42501'; end if;
  perform 1 from public.organizations o where o.id = organization_id_input
    and o.deactivated_at is null for share;
  if not found then raise exception 'Organization not found or deactivated' using errcode = '22023'; end if;
  insert into public.organization_entitlements (organization_id, capability, enabled)
    values (organization_id_input, capability_input, enabled_input)
    on conflict (organization_id, capability) do update set enabled = excluded.enabled, updated_at = now()
    where public.organization_entitlements.enabled is distinct from excluded.enabled;
end;
$$;
