-- Phase 2 administration. Platform operators are provisioned by trusted SQL only.
create type public.organization_status as enum ('active', 'suspended');
alter table public.organizations add column status public.organization_status not null default 'active';

create table public.platform_administrators (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_administrators enable row level security;
revoke all on public.platform_administrators from public, anon, authenticated;
grant select on public.platform_administrators to authenticated;

create function private.is_platform_administrator()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (
    select 1 from public.platform_administrators p where p.user_id = (select auth.uid())
  )
$$;
revoke all on function private.is_platform_administrator() from public, anon;
grant execute on function private.is_platform_administrator() to authenticated;
create policy platform_administrators_self on public.platform_administrators
  for select to authenticated using (user_id = (select auth.uid()));

create type public.organization_entitlement_key as enum (
  'organization_admin', 'model_governance', 'usage_dashboard', 'budget_controls',
  'custom_skills', 'custom_mcps', 'sandbox_profiles', 'lms_integrations',
  'advanced_exports', 'private_model_endpoint', 'enterprise_sso'
);
create table public.organization_entitlements (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  capability public.organization_entitlement_key not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, capability)
);
insert into public.organization_entitlements (organization_id, capability, enabled)
  select id, 'organization_admin', true from public.organizations;
alter table public.organization_entitlements enable row level security;
revoke all on public.organization_entitlements from public, anon, authenticated;
grant select on public.organization_entitlements to authenticated;

create function private.has_organization_entitlement(organization_id_input uuid, capability_input public.organization_entitlement_key)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_entitlements e
    where e.organization_id = organization_id_input and e.capability = capability_input and e.enabled
  )
$$;
revoke all on function private.has_organization_entitlement(uuid, public.organization_entitlement_key) from public, anon;
grant execute on function private.has_organization_entitlement(uuid, public.organization_entitlement_key) to authenticated;

-- The resolver checks an authenticated actor before exposing an entitlement.
create function public.organization_has_entitlement(organization_id_input uuid, capability_input public.organization_entitlement_key)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not (
    private.is_platform_administrator() or private.organization_role_for(organization_id_input) is not null
  ) then raise exception 'Organization access required' using errcode = '42501'; end if;
  return private.has_organization_entitlement(organization_id_input, capability_input);
end;
$$;
revoke all on function public.organization_has_entitlement(uuid, public.organization_entitlement_key) from public, anon;
grant execute on function public.organization_has_entitlement(uuid, public.organization_entitlement_key) to authenticated;

create or replace function private.organization_role_for(organization_id_input uuid)
returns public.organization_role language sql stable security definer set search_path = '' as $$
  select m.role from public.organization_memberships m
  join public.organizations o on o.id = m.organization_id
  where m.organization_id = organization_id_input and o.status = 'active'
    and m.user_id = (select auth.uid()) and m.status = 'active'
$$;
create or replace function private.can_administer_organization(organization_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(private.organization_role_for(organization_id_input) in ('owner', 'admin'), false)
    and private.has_organization_entitlement(organization_id_input, 'organization_admin')
$$;
create or replace function private.can_create_organization_class(organization_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.organization_role_for(organization_id_input) = 'teacher'
    or private.can_administer_organization(organization_id_input)
$$;

drop policy organizations_select on public.organizations;
create policy organizations_select on public.organizations for select to authenticated
  using (private.is_platform_administrator() or private.organization_role_for(id) is not null);
drop policy organizations_update on public.organizations;
create policy organizations_update on public.organizations for update to authenticated
  using (private.can_administer_organization(id)) with check (private.can_administer_organization(id));
drop policy organization_memberships_select on public.organization_memberships;
create policy organization_memberships_select on public.organization_memberships for select to authenticated
  using (private.is_platform_administrator() or private.can_administer_organization(organization_id)
    or (user_id = (select auth.uid()) and status = 'active'));
create policy organization_entitlements_select on public.organization_entitlements for select to authenticated
  using (private.is_platform_administrator() or private.organization_role_for(organization_id) is not null);
drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid()) or
  exists (select 1 from public.class_members cm where cm.user_id = profiles.id and private.can_manage_class(cm.class_id)) or
  exists (select 1 from public.organization_memberships m where m.user_id = profiles.id
    and (private.can_administer_organization(m.organization_id) or private.is_platform_administrator()))
);

-- Phase 1 membership RPCs remain the only tenant write path. This gate also
-- makes disabling the admin entitlement effective for those RPCs immediately.
create function private.require_membership_entitlement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare org_id uuid;
begin
  org_id := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
  if auth.uid() is not null and not private.is_platform_administrator()
    and not private.has_organization_entitlement(org_id, 'organization_admin') then
    raise exception 'Organization administration entitlement required' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.require_membership_entitlement() from public, anon, authenticated;
create trigger require_membership_entitlement before insert or update or delete on public.organization_memberships
  for each row execute function private.require_membership_entitlement();

-- Insert a new administrator entitlement for organizations created by the Phase 1 RPC.
create function private.initialize_organization_entitlements()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.organization_entitlements (organization_id, capability, enabled)
    values (new.id, 'organization_admin', true);
  return new;
end;
$$;
revoke all on function private.initialize_organization_entitlements() from public, anon, authenticated;
create trigger initialize_organization_entitlements after insert on public.organizations
  for each row execute function private.initialize_organization_entitlements();

create table public.administrative_audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  organization_id uuid,
  action text not null,
  target_type text not null,
  target_id text not null,
  result text not null default 'success' check (result in ('success')),
  details jsonb not null default '{}'::jsonb
);
create index administrative_audit_events_org_time_idx on public.administrative_audit_events(organization_id, occurred_at desc);
alter table public.administrative_audit_events enable row level security;
revoke all on public.administrative_audit_events from public, anon, authenticated;
grant select on public.administrative_audit_events to authenticated;
create policy administrative_audit_events_select on public.administrative_audit_events for select to authenticated
  using (private.is_platform_administrator() or
    (organization_id is not null and private.can_administer_organization(organization_id)));

create function private.write_administrative_audit_event()
returns trigger language plpgsql security definer set search_path = '' as $$
declare org_id uuid; event_action text; target_kind text; target_key text; safe_details jsonb := '{}'::jsonb;
begin
  if tg_table_name = 'organizations' then
    org_id := new.id; target_kind := 'organization'; target_key := org_id::text;
    event_action := case when tg_op = 'INSERT' then 'organization.created' else 'organization.updated' end;
    if tg_op = 'UPDATE' then safe_details := jsonb_build_object('name_changed', new.name is distinct from old.name, 'status', new.status); end if;
  elsif tg_table_name = 'organization_memberships' then
    org_id := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end; target_kind := 'membership';
    target_key := case when tg_op = 'DELETE' then old.user_id::text else new.user_id::text end;
    event_action := case
      when tg_op = 'INSERT' then 'membership.added'
      when tg_op = 'DELETE' then 'membership.removed'
      when new.role is distinct from old.role then 'membership.role_changed'
      when new.status is distinct from old.status then 'membership.status_changed'
      else 'membership.updated' end;
    if tg_op <> 'DELETE' then safe_details := jsonb_build_object('role', new.role, 'status', new.status); end if;
    if tg_op = 'UPDATE' then safe_details := safe_details || jsonb_build_object('previous_role', old.role, 'previous_status', old.status); end if;
  elsif tg_table_name = 'classes' then
    org_id := new.organization_id; target_kind := 'class'; target_key := new.id::text;
    event_action := case when tg_op = 'INSERT' then 'class.created' else 'class.organization_changed' end;
    if tg_op = 'UPDATE' then safe_details := jsonb_build_object('previous_organization_id', old.organization_id); end if;
  elsif tg_table_name = 'class_members' then
    select c.organization_id into org_id from public.classes c
      where c.id = case when tg_op = 'DELETE' then old.class_id else new.class_id end;
    target_kind := 'class_teacher';
    target_key := case when tg_op = 'DELETE' then old.user_id::text else new.user_id::text end;
    event_action := case when tg_op = 'DELETE' then 'class.teacher_removed' else 'class.teacher_associated' end;
    safe_details := jsonb_build_object('class_id', case when tg_op = 'DELETE' then old.class_id else new.class_id end);
  else
    org_id := new.organization_id; target_kind := 'entitlement'; target_key := new.capability::text;
    event_action := case when new.enabled then 'entitlement.enabled' else 'entitlement.disabled' end;
  end if;
  if org_id is not null and event_action is not null then
    insert into public.administrative_audit_events
      (actor_user_id, organization_id, action, target_type, target_id, details)
      values (auth.uid(), org_id, event_action, target_kind, target_key, safe_details);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.write_administrative_audit_event() from public, anon, authenticated;
create trigger audit_organizations after insert or update on public.organizations
  for each row execute function private.write_administrative_audit_event();
create trigger audit_memberships after insert or update or delete on public.organization_memberships
  for each row execute function private.write_administrative_audit_event();
create trigger audit_classes after insert or update of organization_id on public.classes
  for each row execute function private.write_administrative_audit_event();
create trigger audit_class_teachers_insert after insert on public.class_members
  for each row when (new.role = 'teacher') execute function private.write_administrative_audit_event();
create trigger audit_class_teachers_delete after delete on public.class_members
  for each row when (old.role = 'teacher') execute function private.write_administrative_audit_event();
create trigger audit_class_teachers_update after update of role, status on public.class_members
  for each row when (new.role = 'teacher' and new.status = 'active' and
    (old.role is distinct from new.role or old.status is distinct from new.status))
  execute function private.write_administrative_audit_event();
create trigger audit_entitlements after insert or update of enabled on public.organization_entitlements
  for each row execute function private.write_administrative_audit_event();

-- Public bootstrap read returns only a boolean, not the platform roster.
create function public.is_platform_administrator()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.is_platform_administrator()
$$;
revoke all on function public.is_platform_administrator() from public, anon;
grant execute on function public.is_platform_administrator() to authenticated;

-- Exact lookup for adding an existing account; no user directory listing.
create function public.resolve_existing_user(organization_id_input uuid, email_input text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare resolved_id uuid;
begin
  if not (private.is_platform_administrator() or private.can_administer_organization(organization_id_input)) then
    raise exception 'Administration required' using errcode = '42501'; end if;
  if email_input is null or char_length(trim(email_input)) > 320 or position('@' in email_input) = 0 then
    raise exception 'Valid email required' using errcode = '22023'; end if;
  select id into resolved_id from public.profiles
    where lower(email) = lower(trim(email_input)) order by id limit 1;
  return resolved_id;
end;
$$;
revoke all on function public.resolve_existing_user(uuid, text) from public, anon;
grant execute on function public.resolve_existing_user(uuid, text) to authenticated;

create function public.set_organization_entitlement(organization_id_input uuid, capability_input public.organization_entitlement_key, enabled_input boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode = '42501'; end if;
  if not exists (select 1 from public.organizations where id = organization_id_input) then
    raise exception 'Organization not found' using errcode = '22023'; end if;
  insert into public.organization_entitlements (organization_id, capability, enabled)
    values (organization_id_input, capability_input, enabled_input)
    on conflict (organization_id, capability) do update set enabled = excluded.enabled, updated_at = now()
    where public.organization_entitlements.enabled is distinct from excluded.enabled;
end;
$$;
revoke all on function public.set_organization_entitlement(uuid, public.organization_entitlement_key, boolean) from public, anon;
grant execute on function public.set_organization_entitlement(uuid, public.organization_entitlement_key, boolean) to authenticated;

create function public.platform_update_organization(organization_id_input uuid, name_input text, status_input public.organization_status)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode = '42501'; end if;
  update public.organizations set name = name_input, status = status_input where id = organization_id_input;
  if not found then raise exception 'Organization not found' using errcode = '22023'; end if;
end;
$$;
revoke all on function public.platform_update_organization(uuid, text, public.organization_status) from public, anon;
grant execute on function public.platform_update_organization(uuid, text, public.organization_status) to authenticated;

create function public.platform_create_organization(slug_input text, name_input text, owner_user_id_input uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare created_id uuid;
begin
  if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode = '42501'; end if;
  if exists (select 1 from public.platform_administrators where user_id = owner_user_id_input) then
    raise exception 'Platform operators cannot appoint themselves tenant owners' using errcode = '42501'; end if;
  insert into public.organizations (slug, name) values (slug_input, name_input) returning id into created_id;
  insert into public.organization_memberships (organization_id, user_id, role, status)
    values (created_id, owner_user_id_input, 'owner', 'active');
  return created_id;
end;
$$;
revoke all on function public.platform_create_organization(text, text, uuid) from public, anon;
grant execute on function public.platform_create_organization(text, text, uuid) to authenticated;

create function public.platform_set_organization_admin(organization_id_input uuid, user_id_input uuid, enabled_input boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare current_role public.organization_role;
begin
  if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode = '42501'; end if;
  if enabled_input and exists (select 1 from public.platform_administrators where user_id = user_id_input) then
    raise exception 'Platform operators cannot gain tenant administration through this workflow' using errcode = '42501'; end if;
  perform 1 from public.organizations where id = organization_id_input for update;
  if not found then raise exception 'Organization not found' using errcode = '22023'; end if;
  select role into current_role from public.organization_memberships
    where organization_id = organization_id_input and user_id = user_id_input;
  if current_role = 'owner' then raise exception 'Owner role cannot be changed by platform admin workflow' using errcode = '23514'; end if;
  if enabled_input then
    insert into public.organization_memberships (organization_id, user_id, role, status)
      values (organization_id_input, user_id_input, 'admin', 'active')
      on conflict (organization_id, user_id) do update set role = 'admin', status = 'active';
  elsif current_role = 'admin' then
    delete from public.organization_memberships where organization_id = organization_id_input and user_id = user_id_input;
  end if;
end;
$$;
revoke all on function public.platform_set_organization_admin(uuid, uuid, boolean) from public, anon;
grant execute on function public.platform_set_organization_admin(uuid, uuid, boolean) to authenticated;

create function public.assign_organization_teacher(organization_id_input uuid, class_id_input uuid, user_id_input uuid, assigned_input boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_administer_organization(organization_id_input) then
    raise exception 'Organization administration required' using errcode = '42501'; end if;
  if not exists (select 1 from public.classes where id = class_id_input and organization_id = organization_id_input) then
    raise exception 'Class does not belong to organization' using errcode = '42501'; end if;
  if assigned_input then
    if not exists (select 1 from public.organization_memberships where organization_id = organization_id_input
      and user_id = user_id_input and status = 'active' and role in ('teacher', 'admin', 'owner')) then
      raise exception 'Teacher must be an active organization member' using errcode = '42501'; end if;
    insert into public.class_members (class_id, user_id, role, status)
      values (class_id_input, user_id_input, 'teacher', 'active')
      on conflict (class_id, user_id) do update set role = 'teacher', status = 'active';
  else
    delete from public.class_members where class_id = class_id_input and user_id = user_id_input and role = 'teacher';
  end if;
end;
$$;
revoke all on function public.assign_organization_teacher(uuid, uuid, uuid, boolean) from public, anon;
grant execute on function public.assign_organization_teacher(uuid, uuid, uuid, boolean) to authenticated;

-- Read-only aggregate: no session text, code, or transcript is exposed.
create function public.platform_organization_summary()
returns table (organization_id uuid, class_count bigint, people_count bigint, student_count bigint, session_count bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode = '42501'; end if;
  return query select o.id,
    (select count(*) from public.classes c where c.organization_id = o.id),
    (select count(*) from public.organization_memberships m where m.organization_id = o.id and m.status = 'active'),
    (select count(distinct cm.user_id) from public.class_members cm join public.classes c on c.id = cm.class_id
      where c.organization_id = o.id and cm.role = 'student' and cm.status = 'active'),
    (select count(*) from public.sessions s join public.classes c on c.id = s.class_id where c.organization_id = o.id)
  from public.organizations o;
end;
$$;
revoke all on function public.platform_organization_summary() from public, anon;
grant execute on function public.platform_organization_summary() to authenticated;
