-- Preferences are private to the teacher and follow the account between devices.
create table public.teacher_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  theme text not null default 'system' check (theme in ('system', 'dark', 'light')),
  density text not null default 'comfortable' check (density in ('comfortable', 'compact')),
  default_join_enabled boolean not null default true,
  overview_days integer not null default 14 check (overview_days in (7, 14, 30)),
  updated_at timestamptz not null default now()
);
alter table public.profiles add column account_deleted_at timestamptz;
alter table public.teacher_preferences enable row level security;
revoke all on public.teacher_preferences from public, anon, authenticated;
grant select, insert, update on public.teacher_preferences to authenticated;
create policy teacher_preferences_select on public.teacher_preferences for select to authenticated
  using (user_id = (select auth.uid()));
create policy teacher_preferences_insert on public.teacher_preferences for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.profiles p where p.id = user_id and p.account_deleted_at is null
  ));
create policy teacher_preferences_update on public.teacher_preferences for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()) and exists (
    select 1 from public.profiles p where p.id = user_id and p.account_deleted_at is null
  ));

drop policy profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid()) and account_deleted_at is null)
  with check (id = (select auth.uid()) and account_deleted_at is null);

create function private.require_live_account()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_user uuid;
begin
  target_user := case when tg_table_name = 'classes' then new.teacher_id else new.user_id end;
  -- Account closure locks the Auth row first, so a concurrent class or
  -- membership insert waits and sees the committed deleted marker.
  perform 1 from auth.users u where u.id = target_user for share;
  if exists (select 1 from public.profiles p where p.id = target_user and p.account_deleted_at is not null) then
    raise exception 'This account has been deleted' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.require_live_account() from public, anon, authenticated;
create trigger require_live_class_teacher before insert or update of teacher_id on public.classes
  for each row execute function private.require_live_account();
create trigger require_live_class_member before insert or update of user_id on public.class_members
  for each row execute function private.require_live_account();
create trigger require_live_organization_member before insert or update of user_id on public.organization_memberships
  for each row execute function private.require_live_account();

create function private.require_open_standalone_class()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Serialize new joins with account closure's update of the class row.
  perform 1 from public.classes c where c.id = new.class_id and c.organization_id is null
    for share;
  if exists (
    select 1 from public.classes c join public.profiles p on p.id = c.teacher_id
    where c.id = new.class_id and c.organization_id is null and p.account_deleted_at is not null
  ) then raise exception 'This class is closed' using errcode = '42501'; end if;
  return new;
end;
$$;
revoke all on function private.require_open_standalone_class() from public, anon, authenticated;
create trigger require_open_standalone_class before insert or update on public.class_members
  for each row execute function private.require_open_standalone_class();

-- Run immediately before Auth Admin's soft delete. Keeping profiles and class
-- records preserves student evidence and foreign keys. The Auth operation then
-- removes the teacher's ability to sign in or refresh a session.
create function public.prepare_teacher_account_deletion(
  confirmation_phrase_input text, confirmed_input boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare requester uuid := auth.uid(); account_email text;
begin
  if requester is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select email into account_email from auth.users where id = requester for update;
  if not found then raise exception 'Account not found' using errcode = '42501'; end if;
  if confirmation_phrase_input is distinct from 'I confirm that I am deleting ' || account_email
    or confirmed_input is distinct from true then
    raise exception 'Deletion confirmation does not match' using errcode = '22023';
  end if;
  perform 1 from public.organizations o join public.organization_memberships m
    on m.organization_id = o.id
    where m.user_id = requester and m.role = 'owner' and m.status = 'active'
      and o.status = 'active' and o.deactivated_at is null
    order by o.id
    for update of o;
  if exists (
    select 1 from public.organization_memberships m
    join public.organizations o on o.id = m.organization_id
    where m.user_id = requester and m.role = 'owner' and m.status = 'active'
      and o.status = 'active' and o.deactivated_at is null
      and not exists (
        select 1 from public.organization_memberships other
        where other.organization_id = m.organization_id and other.user_id <> requester
          and other.role = 'owner' and other.status = 'active'
      )
  ) then raise exception 'Transfer ownership or delete your organization before deleting your account' using errcode = '23514'; end if;

  -- Standalone classes have no successor teacher. Close their access while
  -- retaining projects and historical sessions; managed classes stay active.
  update public.classes set join_enabled = false
    where teacher_id = requester and organization_id is null;
  delete from public.class_members cm using public.classes c
    where cm.class_id = c.id and c.teacher_id = requester and c.organization_id is null;
  delete from public.class_members where user_id = requester;
  update public.profiles set display_name = 'Deleted teacher', email = null, account_deleted_at = now()
    where id = requester;
  delete from public.organization_memberships where user_id = requester;
  delete from public.teacher_preferences where user_id = requester;
end;
$$;
revoke all on function public.prepare_teacher_account_deletion(text, boolean) from public, anon;
grant execute on function public.prepare_teacher_account_deletion(text, boolean) to authenticated;

-- A self-removal as part of account deletion must also work when that
-- organization's administration entitlement is disabled. Ordinary callers
-- cannot set account_deleted_at or delete membership rows directly.
create or replace function private.require_membership_entitlement()
returns trigger language plpgsql security definer set search_path = '' as $$
declare org_id uuid;
begin
  org_id := case when tg_op = 'DELETE' then old.organization_id else new.organization_id end;
  if tg_op = 'DELETE' and old.user_id = auth.uid() and exists (
    select 1 from public.profiles p where p.id = old.user_id and p.account_deleted_at is not null
  ) then return old; end if;
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
