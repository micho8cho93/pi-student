-- Organization administration hardening.
-- Ownership is a lifecycle invariant, not a normal role edit. All exposed
-- mutation paths take the organization row lock so concurrent requests are
-- serialized before they inspect or change membership state.

create or replace function public.set_organization_membership(
  organization_id_input uuid, user_id_input uuid,
  role_input public.organization_role,
  status_input public.organization_membership_status default 'active'
) returns void language plpgsql security definer set search_path = '' as $$
declare
  actor_role public.organization_role;
  old_role public.organization_role;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if role_input = 'owner' then
    raise exception 'Ownership changes require transfer_organization_ownership'
      using errcode = '42501';
  end if;

  perform 1 from public.organizations where id = organization_id_input for update;
  if not found then
    raise exception 'Organization not found' using errcode = '42501';
  end if;

  actor_role := private.organization_role_for(organization_id_input);
  if actor_role is null or actor_role not in ('owner', 'admin')
    or (actor_role = 'admin' and role_input = 'admin') then
    raise exception 'Organization administration required' using errcode = '42501';
  end if;

  select m.role into old_role
    from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id = user_id_input
    for update;

  if actor_role = 'admin' and old_role in ('owner', 'admin') then
    raise exception 'Owner access required' using errcode = '42501';
  end if;
  if old_role = 'owner' then
    raise exception 'Ownership changes require transfer_organization_ownership'
      using errcode = '42501';
  end if;

  insert into public.organization_memberships (organization_id, user_id, role, status)
    values (organization_id_input, user_id_input, role_input, status_input)
    on conflict (organization_id, user_id) do update
      set role = excluded.role, status = excluded.status;
end;
$$;

revoke all on function public.set_organization_membership(
  uuid, uuid, public.organization_role, public.organization_membership_status
) from public, anon;
grant execute on function public.set_organization_membership(
  uuid, uuid, public.organization_role, public.organization_membership_status
) to authenticated;

create function public.transfer_organization_ownership(
  organization_id_input uuid,
  target_user_id_input uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  actor_role public.organization_role;
  target_role public.organization_role;
  target_status public.organization_membership_status;
begin
  if actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if target_user_id_input = actor then
    raise exception 'Choose another active organization member'
      using errcode = '23514';
  end if;

  -- Every ownership transition for this organization takes the same lock as
  -- membership edits, removals, and class assignment changes.
  perform 1 from public.organizations
    where id = organization_id_input and status = 'active' and deactivated_at is null
    for update;
  if not found then
    raise exception 'Active organization required' using errcode = '42501';
  end if;

  actor_role := private.organization_role_for(organization_id_input);
  if actor_role is distinct from 'owner' then
    raise exception 'Organization owner required' using errcode = '42501';
  end if;

  select m.role, m.status into target_role, target_status
    from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id = target_user_id_input
    for update;
  if target_role is null then
    raise exception 'Target must be an organization member' using errcode = '42501';
  end if;
  if target_status <> 'active' then
    raise exception 'Target must be an active organization member' using errcode = '42501';
  end if;
  if target_role = 'owner' then
    raise exception 'Target is already an organization owner' using errcode = '23514';
  end if;

  -- Promote first, then demote the caller. The deferred invariant also
  -- protects this operation if another trusted path is added later.
  update public.organization_memberships
    set role = 'owner', status = 'active'
    where organization_id = organization_id_input and user_id = target_user_id_input;
  update public.organization_memberships
    set role = 'admin', status = 'active'
    where organization_id = organization_id_input and user_id = actor;
  insert into public.administrative_audit_events
    (actor_user_id, organization_id, action, target_type, target_id, details)
    values (actor, organization_id_input, 'organization.ownership_transferred', 'membership',
      target_user_id_input::text, jsonb_build_object('previous_owner_user_id', actor));
end;
$$;

revoke all on function public.transfer_organization_ownership(uuid, uuid) from public, anon;
grant execute on function public.transfer_organization_ownership(uuid, uuid) to authenticated;

create or replace function public.remove_organization_membership(
  organization_id_input uuid,
  user_id_input uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare
  actor_role public.organization_role;
  old_role public.organization_role;
  old_status public.organization_membership_status;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform 1 from public.organizations where id = organization_id_input for update;
  if not found then
    raise exception 'Organization not found' using errcode = '42501';
  end if;
  actor_role := private.organization_role_for(organization_id_input);
  select m.role, m.status into old_role, old_status
    from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id = user_id_input
    for update;
  if actor_role is null or actor_role not in ('owner', 'admin')
    or (actor_role = 'admin' and old_role in ('owner', 'admin')) then
    raise exception 'Organization administration required' using errcode = '42501';
  end if;
  if old_role = 'owner' and old_status = 'active' and not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id <> user_id_input
      and m.role = 'owner' and m.status = 'active'
  ) then
    raise exception 'Cannot remove the final active owner' using errcode = '23514';
  end if;
  if old_role = 'owner' then
    raise exception 'Ownership changes require transfer_organization_ownership'
      using errcode = '42501';
  end if;
  delete from public.organization_memberships m
    where m.organization_id = organization_id_input and m.user_id = user_id_input;
end;
$$;

revoke all on function public.remove_organization_membership(uuid, uuid) from public, anon;
grant execute on function public.remove_organization_membership(uuid, uuid) to authenticated;

-- Replace the old one-checkbox-per-request API. The function derives the
-- tenant from the class, validates the complete requested set, and only then
-- replaces the teacher rows in one transaction.
revoke all on function public.assign_organization_teacher(uuid, uuid, uuid, boolean) from public, anon, authenticated;
drop function public.assign_organization_teacher(uuid, uuid, uuid, boolean);

create function public.set_class_teacher_assignments(
  class_id_input uuid,
  teacher_ids_input uuid[]
) returns void language plpgsql security definer set search_path = '' as $$
declare
  organization_id_key uuid;
  requested_count integer;
  distinct_count integer;
begin
  if teacher_ids_input is null then
    raise exception 'Teacher assignment set is required' using errcode = '22023';
  end if;

  select c.organization_id into organization_id_key
    from public.classes c
    where c.id = class_id_input
    for update;
  if organization_id_key is null then
    raise exception 'Class does not belong to an organization' using errcode = '42501';
  end if;
  perform 1 from public.organizations
    where id = organization_id_key and status = 'active' and deactivated_at is null
    for update;
  if not found or not private.can_administer_organization(organization_id_key) then
    raise exception 'Organization administration required' using errcode = '42501';
  end if;

  select count(*), count(distinct requested.user_id)
    into requested_count, distinct_count
    from unnest(teacher_ids_input) as requested(user_id);
  if exists (select 1 from unnest(teacher_ids_input) as requested(user_id) where requested.user_id is null)
    or requested_count <> distinct_count then
    raise exception 'Teacher assignment set contains duplicate or null IDs' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(teacher_ids_input) as requested(user_id)
    where not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = organization_id_key and m.user_id = requested.user_id
        and m.status = 'active' and m.role in ('teacher', 'admin', 'owner')
    )
  ) then
    raise exception 'Every teacher must be an active member of this organization'
      using errcode = '42501';
  end if;
  if exists (
    select 1 from public.class_members cm
    where cm.class_id = class_id_input and cm.role = 'student'
      and cm.user_id = any(teacher_ids_input)
  ) then
    raise exception 'A class student cannot also be assigned as a teacher'
      using errcode = '23514';
  end if;

  delete from public.class_members
    where class_id = class_id_input and role = 'teacher';
  insert into public.class_members (class_id, user_id, role, status)
    select class_id_input, requested.user_id, 'teacher', 'active'
    from unnest(teacher_ids_input) as requested(user_id);

  insert into public.administrative_audit_events
    (actor_user_id, organization_id, action, target_type, target_id, details)
    values (auth.uid(), organization_id_key, 'class.teacher_assignments_replaced', 'class',
      class_id_input::text, jsonb_build_object('teacher_count', cardinality(teacher_ids_input)));
end;
$$;

revoke all on function public.set_class_teacher_assignments(uuid, uuid[]) from public, anon;
grant execute on function public.set_class_teacher_assignments(uuid, uuid[]) to authenticated;

-- A direct trusted write must not be able to leave an active organization
-- without an active owner. This is deferred so create/transfer/deactivation
-- can make multiple related writes in one transaction.
create or replace function private.assert_active_organization_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
declare organization_id_key uuid;
begin
  if tg_table_name = 'organizations' then
    organization_id_key := new.id;
  elsif tg_op = 'DELETE' then
    organization_id_key := old.organization_id;
  else
    organization_id_key := new.organization_id;
  end if;
  if exists (
    select 1 from public.organizations o
    where o.id = organization_id_key and o.status = 'active' and o.deactivated_at is null
  ) and not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = organization_id_key and m.role = 'owner' and m.status = 'active'
  ) then
    raise exception 'Organization must retain at least one active owner' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'organization_memberships' then
    if old.organization_id is distinct from new.organization_id
      and exists (
        select 1 from public.organizations o
        where o.id = old.organization_id and o.status = 'active' and o.deactivated_at is null
      ) and not exists (
        select 1 from public.organization_memberships m
        where m.organization_id = old.organization_id and m.role = 'owner' and m.status = 'active'
      ) then
      raise exception 'Organization must retain at least one active owner' using errcode = '23514';
    end if;
  end if;
  return null;
end;
$$;
revoke all on function private.assert_active_organization_owner() from public, anon, authenticated;

create constraint trigger organization_memberships_require_owner
after insert or delete or update of organization_id, user_id, role, status
on public.organization_memberships
deferrable initially deferred for each row
execute function private.assert_active_organization_owner();

create constraint trigger organizations_require_owner
after insert or update of status, deactivated_at
on public.organizations
deferrable initially deferred for each row
execute function private.assert_active_organization_owner();

do $$
begin
  if exists (
    select 1 from public.organizations o
    where o.status = 'active' and o.deactivated_at is null
      and not exists (
        select 1 from public.organization_memberships m
        where m.organization_id = o.id and m.role = 'owner' and m.status = 'active'
      )
  ) then
    raise exception 'Existing active organizations must have an active owner' using errcode = '23514';
  end if;
end;
$$;
