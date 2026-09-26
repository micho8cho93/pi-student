begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

-- The blocked-sites CHECK constraint calls private.valid_sandbox_blocked_sites, so every
-- authenticated write to an organization row needs EXECUTE on it. These checks run as
-- the signed-in users themselves; validation and tenancy must still hold.
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) values
  ('5b000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'sites-a-admin@example.test', '{}', '{}'),
  ('5b000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'sites-a-teacher@example.test', '{}', '{}'),
  ('5b000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'sites-a-student@example.test', '{}', '{}'),
  ('5b000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'sites-b-owner@example.test', '{}', '{}');
insert into public.organizations (id, slug, name) values
  ('5c000000-0000-0000-0000-000000000001', 'sites-a-test', 'Sites A'),
  ('5c000000-0000-0000-0000-000000000002', 'sites-b-test', 'Sites B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('5c000000-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000001', 'admin'),
  ('5c000000-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000002', 'teacher'),
  ('5c000000-0000-0000-0000-000000000001', '5b000000-0000-0000-0000-000000000003', 'member'),
  ('5c000000-0000-0000-0000-000000000002', '5b000000-0000-0000-0000-000000000004', 'owner');

set local role authenticated;
select set_config('request.jwt.claim.sub', '5b000000-0000-0000-0000-000000000001', true);
select lives_ok($$ update public.organizations set name = 'Sites A renamed' where id = '5c000000-0000-0000-0000-000000000001' $$,
  'an organization administrator can update organization details under the blocked-sites check');
select lives_ok($$ select public.save_organization_sandbox_blocked_sites('5c000000-0000-0000-0000-000000000001', array[' Games.Example.test ', 'games.example.test', 'chat.example.test']) $$,
  'an organization administrator can save blocked sites');
select results_eq($$ select sandbox_blocked_sites from public.organizations where id = '5c000000-0000-0000-0000-000000000001' $$,
  $$ values (array['chat.example.test', 'games.example.test']::text[]) $$, 'blocked sites are normalized, deduplicated and sorted');
select throws_ok($$ select public.save_organization_sandbox_blocked_sites('5c000000-0000-0000-0000-000000000001', array['not a host']) $$,
  '22023', 'Blocked sites must be valid hostnames', 'invalid hostnames are rejected');
select throws_ok($$ select public.save_organization_sandbox_blocked_sites('5c000000-0000-0000-0000-000000000001', array['']) $$,
  '22023', 'Invalid sandbox blocked sites', 'empty entries are rejected');
select throws_ok($$ update public.organizations set sandbox_blocked_sites = array['NOT A HOST'] where id = '5c000000-0000-0000-0000-000000000001' $$,
  '42501', null, 'administrators cannot write blocked sites around the validating function');
select throws_ok($$ select public.save_organization_sandbox_blocked_sites('5c000000-0000-0000-0000-000000000002', array['games.example.test']) $$,
  '42501', 'Organization administrator required', 'an administrator cannot change another organization');

select set_config('request.jwt.claim.sub', '5b000000-0000-0000-0000-000000000002', true);
select throws_ok($$ select public.save_organization_sandbox_blocked_sites('5c000000-0000-0000-0000-000000000001', array['games.example.test']) $$,
  '42501', 'Organization administrator required', 'a teacher cannot change organization blocked sites');
select is_empty($$ update public.organizations set name = 'Teacher rename' where id = '5c000000-0000-0000-0000-000000000001' returning id $$,
  'a teacher cannot update organization details');

select set_config('request.jwt.claim.sub', '5b000000-0000-0000-0000-000000000003', true);
select throws_ok($$ select public.save_organization_sandbox_blocked_sites('5c000000-0000-0000-0000-000000000001', array['games.example.test']) $$,
  '42501', 'Organization administrator required', 'a student cannot change organization blocked sites');

select set_config('request.jwt.claim.sub', '5b000000-0000-0000-0000-000000000004', true);
select is_empty($$ update public.organizations set name = 'Hijacked' where id = '5c000000-0000-0000-0000-000000000001' returning id $$,
  'another organization''s owner cannot update this organization');

reset role;
select throws_ok($$ update public.organizations set sandbox_blocked_sites = array['NOT A HOST'] where id = '5c000000-0000-0000-0000-000000000001' $$,
  '23514', null, 'the check constraint still rejects invalid blocked sites for every writer');

select * from finish();
rollback;
