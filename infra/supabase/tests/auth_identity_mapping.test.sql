begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(13);

-- A first Google sign-in inserts one auth.users row; the application identity must derive from it and nothing more.
insert into public.organizations (id, slug, name) values ('61000000-0000-0000-0000-0000000000a1', 'auth-map-org', 'Auth mapping org');
create temporary table auth_baseline as select
  (select count(*) from public.organization_memberships) as memberships,
  (select count(*) from public.class_members) as class_members,
  (select count(*) from public.platform_administrators) as platform_admins;

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) values
  ('61000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'google.person@example.test', '{"provider":"google"}', '{"full_name":"Google Person"}'),
  ('61000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'no.metadata@example.test', '{"provider":"google"}', '{}'),
  ('61000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', null, '{"provider":"google"}', '{}');

select results_eq($$ select display_name, email from public.profiles where id = '61000000-0000-0000-0000-000000000001' $$, $$ values ('Google Person'::text, 'google.person@example.test'::text) $$, 'Google sign-in creates a profile from the provider identity');
select results_eq($$ select display_name from public.profiles where id = '61000000-0000-0000-0000-000000000002' $$, $$ values ('no.metadata'::text) $$, 'missing provider name falls back to the email local part');
select is((select count(*) from public.profiles where id = '61000000-0000-0000-0000-000000000003'), 1::bigint, 'an account without an email still gets exactly one profile');
select is((select count(*) from public.profiles where id in ('61000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000002','61000000-0000-0000-0000-000000000003')), 3::bigint, 'each sign-in maps to exactly one profile');

select results_eq($$ select (select count(*) from public.organization_memberships) - memberships, (select count(*) from public.class_members) - class_members, (select count(*) from public.platform_administrators) - platform_admins from auth_baseline $$,
  $$ values (0::bigint, 0::bigint, 0::bigint) $$, 'sign-in never grants organization, class or platform membership');

set local role authenticated;
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000001', true);
select is((select count(*) from public.organizations), 0::bigint, 'a signed-in account without membership sees no organizations');
select is((select count(*) from public.organization_memberships), 0::bigint, 'and no organization memberships');
select is(public.is_platform_administrator(), false, 'a new account is not a platform operator');
select throws_ok($$ select public.organization_has_entitlement('61000000-0000-0000-0000-0000000000a1', 'organization_admin') $$, '42501', 'Organization access required', 'a new account cannot probe organization entitlements');
select is((select count(*) from public.profiles where id <> '61000000-0000-0000-0000-000000000001'), 0::bigint, 'a new account cannot read other profiles');
select throws_ok($$ select public.platform_users() $$, '42501', 'Platform administration required', 'a new account cannot list platform users');

-- Identity is per-user: switching the JWT subject switches what is visible.
select set_config('request.jwt.claim.sub', '61000000-0000-0000-0000-000000000002', true);
select is((select count(*) from public.profiles), 1::bigint, 'a second account sees only its own profile');
reset role;
delete from auth.users where id = '61000000-0000-0000-0000-000000000002';
select is((select count(*) from public.profiles where id = '61000000-0000-0000-0000-000000000002'), 0::bigint, 'deleting the auth user leaves no orphan profile');

select * from finish();
rollback;
