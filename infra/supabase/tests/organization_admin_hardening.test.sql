begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(28);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) values
  ('a5100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'hardening-owner@example.test', '{}', '{}'),
  ('a5100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'hardening-admin@example.test', '{}', '{}'),
  ('a5100000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'hardening-teacher-a@example.test', '{}', '{}'),
  ('a5100000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'hardening-teacher-b@example.test', '{}', '{}'),
  ('a5100000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'hardening-member@example.test', '{}', '{}'),
  ('a5100000-0000-0000-0000-000000000006', 'authenticated', 'authenticated', 'hardening-suspended-owner@example.test', '{}', '{}'),
  ('a5200000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'hardening-other-owner@example.test', '{}', '{}'),
  ('a5200000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'hardening-other-teacher@example.test', '{}', '{}');

insert into public.organizations (id, slug, name) values
  ('a5300000-0000-0000-0000-000000000001', 'hardening-org-a', 'Hardening A'),
  ('a5300000-0000-0000-0000-000000000002', 'hardening-org-b', 'Hardening B');
insert into public.organization_memberships (organization_id, user_id, role, status) values
  ('a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000002', 'admin', 'active'),
  ('a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000003', 'teacher', 'active'),
  ('a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000004', 'teacher', 'active'),
  ('a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000005', 'member', 'active'),
  ('a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000006', 'owner', 'suspended'),
  ('a5300000-0000-0000-0000-000000000002', 'a5200000-0000-0000-0000-000000000001', 'owner', 'active'),
  ('a5300000-0000-0000-0000-000000000002', 'a5200000-0000-0000-0000-000000000002', 'teacher', 'active');
insert into public.classes (id, organization_id, teacher_id, name, join_code) values
  ('a5400000-0000-0000-0000-000000000001', 'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000003', 'Hardening A class', 'HAA-234'),
  ('a5400000-0000-0000-0000-000000000002', 'a5300000-0000-0000-0000-000000000002', 'a5200000-0000-0000-0000-000000000002', 'Hardening B class', 'HBB-234');
insert into public.class_members (class_id, user_id, role, status) values
  ('a5400000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000003', 'teacher', 'active');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a5100000-0000-0000-0000-000000000001', true);
select lives_ok($$ select public.transfer_organization_ownership(
  'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000002') $$,
  'owner can transfer ownership to an active organization member');
select is((select role::text from public.organization_memberships where organization_id = 'a5300000-0000-0000-0000-000000000001' and user_id = 'a5100000-0000-0000-0000-000000000001'), 'admin', 'previous owner becomes administrator');
select is((select role::text from public.organization_memberships where organization_id = 'a5300000-0000-0000-0000-000000000001' and user_id = 'a5100000-0000-0000-0000-000000000002'), 'owner', 'target becomes owner');
select is((select count(*)::integer from public.organization_memberships where organization_id = 'a5300000-0000-0000-0000-000000000001' and role = 'owner' and status = 'active'), 1, 'transfer preserves exactly one active owner here');
select is((select count(*)::integer from public.administrative_audit_events where organization_id = 'a5300000-0000-0000-0000-000000000001' and action = 'organization.ownership_transferred' and target_id = 'a5100000-0000-0000-0000-000000000002'), 1, 'ownership transfer is audited as a distinct operation');
select ok(position('for update' in lower(pg_get_functiondef('public.transfer_organization_ownership(uuid,uuid)'::regprocedure))) > 0, 'ownership transfer locks the organization row for concurrent changes');
select ok(position('for update' in lower(pg_get_functiondef('public.set_class_teacher_assignments(uuid,uuid[])'::regprocedure))) > 0, 'teacher replacement locks its class and organization for concurrent changes');

select throws_ok($$ select public.set_organization_membership(
  'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000001', 'owner') $$,
  '42501', 'Ownership changes require transfer_organization_ownership', 'ordinary role edit cannot promote an administrator to owner');
select set_config('request.jwt.claim.sub', 'a5100000-0000-0000-0000-000000000001', true);
select throws_ok($$ select public.transfer_organization_ownership(
  'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000003') $$,
  '42501', 'Organization owner required', 'administrator cannot invoke ownership transfer');
select set_config('request.jwt.claim.sub', 'a5100000-0000-0000-0000-000000000002', true);
select throws_ok($$ select public.set_organization_membership(
  'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000002', 'admin') $$,
  '42501', 'Ownership changes require transfer_organization_ownership', 'owner cannot self-demote through an ordinary role edit');
select throws_ok($$ select public.remove_organization_membership(
  'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000002') $$,
  '23514', 'Cannot remove the final active owner', 'final active owner cannot disappear');
select throws_ok($$ select public.transfer_organization_ownership(
  'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000006') $$,
  '42501', 'Target must be an active organization member', 'suspended owner does not satisfy active ownership');
select throws_ok($$ select public.transfer_organization_ownership(
  'a5300000-0000-0000-0000-000000000001', 'a5200000-0000-0000-0000-000000000002') $$,
  '42501', 'Target must be an organization member', 'cross-organization ownership is rejected');

select lives_ok($$ select public.set_class_teacher_assignments(
  'a5400000-0000-0000-0000-000000000001', array[
    'a5100000-0000-0000-0000-000000000003'::uuid,
    'a5100000-0000-0000-0000-000000000004'::uuid]) $$,
  'complete teacher assignment set commits atomically');
select is((select count(*)::integer from public.class_members where class_id = 'a5400000-0000-0000-0000-000000000001' and role = 'teacher' and status = 'active'), 2, 'both requested teachers are active');
select throws_ok($$ select public.set_class_teacher_assignments(
  'a5400000-0000-0000-0000-000000000001', array[
    'a5100000-0000-0000-0000-000000000003'::uuid,
    'a5100000-0000-0000-0000-000000000005'::uuid]) $$,
  '42501', 'Every teacher must be an active member of this organization', 'invalid organization member rejects the whole assignment');
select is((select count(*)::integer from public.class_members where class_id = 'a5400000-0000-0000-0000-000000000001' and role = 'teacher' and status = 'active'), 2, 'invalid teacher leaves the previous assignment set intact');
select throws_ok($$ select public.set_class_teacher_assignments(
  'a5400000-0000-0000-0000-000000000001', array['a5200000-0000-0000-0000-000000000002'::uuid]) $$,
  '42501', 'Every teacher must be an active member of this organization', 'cross-organization teacher rejects the whole assignment');
select throws_ok($$ select public.set_class_teacher_assignments(
  'a5400000-0000-0000-0000-000000000001', array[
    'a5100000-0000-0000-0000-000000000003'::uuid,
    'a5100000-0000-0000-0000-000000000003'::uuid]) $$,
  '22023', 'Teacher assignment set contains duplicate or null IDs', 'duplicate teacher IDs are rejected');
select is((select count(*)::integer from public.class_members where class_id = 'a5400000-0000-0000-0000-000000000001' and role = 'teacher' and status = 'active'), 2, 'duplicate validation leaves the previous assignment set intact');
select lives_ok($$ select public.set_class_teacher_assignments(
  'a5400000-0000-0000-0000-000000000001', array[]::uuid[]) $$,
  'empty assignment is a valid atomic clear');
select is((select count(*)::integer from public.class_members where class_id = 'a5400000-0000-0000-0000-000000000001' and role = 'teacher'), 0, 'empty assignment removes all teachers');
select lives_ok($$ select public.set_class_teacher_assignments(
  'a5400000-0000-0000-0000-000000000001', array['a5100000-0000-0000-0000-000000000003'::uuid]) $$,
  'assignment can be restored after an empty set');
select set_config('request.jwt.claim.sub', 'a5100000-0000-0000-0000-000000000001', true);
select throws_ok($$ select public.set_class_teacher_assignments(
  'a5400000-0000-0000-0000-000000000002', array['a5200000-0000-0000-0000-000000000002'::uuid]) $$,
  '42501', 'Organization administration required', 'administrator cannot assign teachers in another organization');
select set_config('request.jwt.claim.sub', 'a5100000-0000-0000-0000-000000000002', true);
select lives_ok($$ select public.set_organization_membership(
  'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000003', 'member') $$,
  'owner can change a teacher role');
select set_config('request.jwt.claim.sub', 'a5100000-0000-0000-0000-000000000003', true);
select results_eq($$ select count(*) from public.classes where id = 'a5400000-0000-0000-0000-000000000001' $$,
  $$ values (0::bigint) $$, 'changed organization role removes managed class access immediately');
select set_config('request.jwt.claim.sub', 'a5100000-0000-0000-0000-000000000002', true);
select lives_ok($$ select public.set_organization_membership(
  'a5300000-0000-0000-0000-000000000001', 'a5100000-0000-0000-0000-000000000003', 'teacher') $$,
  'owner can restore the teacher role through the authoritative membership RPC');
select results_eq($$ select count(*) from public.administrative_audit_events
  where organization_id = 'a5300000-0000-0000-0000-000000000001'
    and action = 'class.teacher_assignments_replaced' $$,
  $$ values (3::bigint) $$, 'teacher assignment replacements are audited once per committed operation');

select * from finish();
rollback;
