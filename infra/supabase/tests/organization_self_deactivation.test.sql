begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(24);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) values
  ('91000000-0000-0000-0000-000000000001','authenticated','authenticated','closure-owner@example.test','{}','{}'),
  ('91000000-0000-0000-0000-000000000002','authenticated','authenticated','closure-admin@example.test','{}','{}'),
  ('91000000-0000-0000-0000-000000000003','authenticated','authenticated','closure-teacher@example.test','{}','{}'),
  ('91000000-0000-0000-0000-000000000004','authenticated','authenticated','closure-student@example.test','{}','{}'),
  ('91000000-0000-0000-0000-000000000005','authenticated','authenticated','other-owner@example.test','{}','{}'),
  ('91000000-0000-0000-0000-000000000006','authenticated','authenticated','closure-operator@example.test','{}','{}');
insert into public.platform_administrators (user_id) values ('91000000-0000-0000-0000-000000000006');
insert into public.organizations (id,slug,name) values
  ('92000000-0000-0000-0000-000000000001','closure-a','Test Organization'),
  ('92000000-0000-0000-0000-000000000002','closure-b','Other Organization');
insert into public.organization_memberships (organization_id,user_id,role) values
  ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001','owner'),
  ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000002','admin'),
  ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000003','teacher'),
  ('92000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000005','owner');
insert into public.classes (id,teacher_id,organization_id,name,join_code) values
  ('93000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000003','92000000-0000-0000-0000-000000000001','Managed class','ABC-234'),
  ('93000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000005','92000000-0000-0000-0000-000000000002','Other class','DEF-234');
insert into public.class_members (class_id,user_id,role,status) values
  ('93000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000004','student','active');
insert into public.projects (id,class_id,name) values
  ('94000000-0000-0000-0000-000000000001','93000000-0000-0000-0000-000000000001','Retained project');
insert into public.sessions (id,student_id,class_id,project_id,started_at,ended_at) values
  ('95000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000004',
    '93000000-0000-0000-0000-000000000001','94000000-0000-0000-0000-000000000001',now(),now());

set local role authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
select lives_ok($$ update public.organizations set contact_email='office@example.test',
  teachers_can_create_classes=false, students_can_join_by_code=false
  where id='92000000-0000-0000-0000-000000000001' $$,'owner can set account and experience details');
select results_eq($$ select teachers_can_create_classes,students_can_join_by_code from public.organizations
  where id='92000000-0000-0000-0000-000000000001' $$,$$ values(false,false) $$,'saved preferences are readable');

select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000003',true);
select throws_ok($$ insert into public.classes (teacher_id,organization_id,name)
  values ('91000000-0000-0000-0000-000000000003','92000000-0000-0000-0000-000000000001','Blocked class') $$,
  '42501',null,'teacher class creation obeys preference');
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000004',true);
select results_eq($$ select count(*) from public.join_class('ABC-234') $$,$$ values (0::bigint) $$,
  'disabled join code is unavailable');
select results_eq($$ select count(*) from public.class_members where class_id='93000000-0000-0000-0000-000000000001' $$,
  $$ values (1::bigint) $$,'existing student membership remains while join is disabled');

select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000002',true);
select throws_ok($$ select public.deactivate_organization('92000000-0000-0000-0000-000000000001',
  'I confirm that I am deleting Test Organization',true) $$,'42501','Organization owner required',
  'administrator cannot delete organization');
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
select throws_ok($$ select public.deactivate_organization('92000000-0000-0000-0000-000000000001',
  'I confirm that I am deleting Other Organization',true) $$,'22023','Deletion confirmation does not match',
  'phrase must match current organization name');
select throws_ok($$ select public.deactivate_organization('92000000-0000-0000-0000-000000000001',
  'I confirm that I am deleting Test Organization',false) $$,'22023','Deletion confirmation does not match',
  'final checkbox must be confirmed');
select lives_ok($$ select public.deactivate_organization('92000000-0000-0000-0000-000000000001',
  'I confirm that I am deleting Test Organization',true) $$,'owner can deactivate with both confirmations');

reset role;
select is((select status::text from public.organizations where id='92000000-0000-0000-0000-000000000001'),
  'suspended','organization is inactive');
select ok((select deactivated_at is not null from public.organizations where id='92000000-0000-0000-0000-000000000001'),
  'deactivation timestamp is retained');
select results_eq($$ select count(*) from public.organization_memberships where organization_id='92000000-0000-0000-0000-000000000001' $$,
  $$ values (0::bigint) $$,'all organization memberships are removed');
select results_eq($$ select count(*) from public.class_members where class_id='93000000-0000-0000-0000-000000000001' $$,
  $$ values (0::bigint) $$,'managed class memberships are removed');
select results_eq($$ select count(*) from public.classes where id='93000000-0000-0000-0000-000000000001' $$,
  $$ values (1::bigint) $$,'class data is retained');
select results_eq($$ select count(*) from public.projects where id='94000000-0000-0000-0000-000000000001' $$,
  $$ values (1::bigint) $$,'project data is retained');
select results_eq($$ select count(*) from public.sessions where id='95000000-0000-0000-0000-000000000001' $$,
  $$ values (1::bigint) $$,'student session data is retained');
select results_eq($$ select count(*) from public.organization_memberships where organization_id='92000000-0000-0000-0000-000000000002' $$,
  $$ values (1::bigint) $$,'other organization remains connected');
select results_eq($$ select count(*) from public.administrative_audit_events where organization_id='92000000-0000-0000-0000-000000000001'
  and action='organization.deactivated' $$,$$ values (1::bigint) $$,'deactivation is audited');

set local role authenticated;
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
select results_eq($$ select count(*) from public.organizations where id='92000000-0000-0000-0000-000000000001' $$,
  $$ values (0::bigint) $$,'former owner cannot access organization');
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000004',true);
select results_eq($$ select count(*) from public.classes where id='93000000-0000-0000-0000-000000000001' $$,
  $$ values (0::bigint) $$,'former student cannot access managed class');
select results_eq($$ select count(*) from public.sessions where id='95000000-0000-0000-0000-000000000001' $$,
  $$ values (0::bigint) $$,'former student cannot access retained managed session');
select results_eq($$ select count(*) from public.join_class('ABC-234') $$,$$ values (0::bigint) $$,
  'former student cannot rejoin deactivated class');
select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000006',true);
select throws_ok($$ select public.platform_update_organization('92000000-0000-0000-0000-000000000001',
  'Test Organization','active') $$,'22023','Organization not found or deactivated',
  'platform status edit cannot reactivate deleted organization');
select throws_ok($$ select public.set_organization_entitlement('92000000-0000-0000-0000-000000000001',
  'organization_admin',true) $$,'22023','Organization not found or deactivated',
  'platform cannot alter deleted organization grants');

select * from finish();
rollback;
