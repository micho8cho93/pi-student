begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(20);

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
  ('a1000000-0000-0000-0000-000000000001','authenticated','authenticated','owner-settings@example.test','{}','{}'),
  ('a1000000-0000-0000-0000-000000000002','authenticated','authenticated','teacher-settings@example.test','{}','{}'),
  ('a1000000-0000-0000-0000-000000000003','authenticated','authenticated','student-settings@example.test','{}','{}');
insert into public.organizations (id,slug,name) values
  ('a2000000-0000-0000-0000-000000000001','teacher-settings-test','Settings School');
insert into public.organization_memberships (organization_id,user_id,role) values
  ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','owner'),
  ('a2000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002','teacher');
insert into public.classes (id,teacher_id,organization_id,name,join_code) values
  ('a3000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000002',null,'Standalone settings class','ABC-234'),
  ('a3000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000002','a2000000-0000-0000-0000-000000000001','Managed settings class','DEF-567');
-- Class creation already enrolled each class teacher (private.add_teacher_membership).
insert into public.class_members (class_id,user_id,role,status) values
  ('a3000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000003','student','active'),
  ('a3000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','student','active');
insert into public.sessions (id,student_id,class_id,started_at,ended_at) values
  ('a4000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000003','a3000000-0000-0000-0000-000000000001',now(),now()),
  ('a4000000-0000-0000-0000-000000000002','a1000000-0000-0000-0000-000000000003','a3000000-0000-0000-0000-000000000002',now(),now());

set local role authenticated;
select set_config('request.jwt.claim.sub','a1000000-0000-0000-0000-000000000002',true);
select lives_ok($$ insert into public.teacher_preferences (user_id,theme,density,default_join_enabled,overview_days)
  values ('a1000000-0000-0000-0000-000000000002','light','compact',false,30) $$,
  'teacher can save own preferences');
select results_eq($$ select theme,overview_days from public.teacher_preferences
  where user_id='a1000000-0000-0000-0000-000000000002' $$,
  $$ values ('light'::text,30) $$,'teacher can read own preferences');
select throws_ok($$ insert into public.teacher_preferences (user_id)
  values ('a1000000-0000-0000-0000-000000000001') $$,
  '42501',null,'teacher cannot save another account preferences');
select throws_ok($$ select public.prepare_teacher_account_deletion('wrong phrase',true) $$,
  '22023','Deletion confirmation does not match','typed phrase is required');
select throws_ok($$ select public.prepare_teacher_account_deletion(
  'I confirm that I am deleting teacher-settings@example.test',false) $$,
  '22023','Deletion confirmation does not match','final confirmation is required');

select set_config('request.jwt.claim.sub','a1000000-0000-0000-0000-000000000001',true);
select throws_ok($$ select public.prepare_teacher_account_deletion(
  'I confirm that I am deleting owner-settings@example.test',true) $$,
  '23514','Transfer ownership or delete your organization before deleting your account',
  'sole active owner cannot delete their account');

select set_config('request.jwt.claim.sub','a1000000-0000-0000-0000-000000000002',true);
select lives_ok($$ select public.prepare_teacher_account_deletion(
  'I confirm that I am deleting teacher-settings@example.test',true) $$,
  'confirmed teacher account is prepared for Auth deletion');
reset role;
select is((select display_name from public.profiles where id='a1000000-0000-0000-0000-000000000002'),
  'Deleted teacher','personal display name is removed');
select ok((select email is null from public.profiles where id='a1000000-0000-0000-0000-000000000002'),
  'profile email is removed');
select ok((select account_deleted_at is not null from public.profiles where id='a1000000-0000-0000-0000-000000000002'),
  'account is marked deleted in public data');
select results_eq($$ select count(*) from public.teacher_preferences
  where user_id='a1000000-0000-0000-0000-000000000002' $$,$$ values (0::bigint) $$,
  'personal preferences are removed');
select is((select join_enabled from public.classes where id='a3000000-0000-0000-0000-000000000001'),
  false,'standalone joining is closed');
select results_eq($$ select count(*) from public.class_members
  where class_id='a3000000-0000-0000-0000-000000000001' $$,$$ values (0::bigint) $$,
  'standalone memberships are removed');
select results_eq($$ select count(*) from public.class_members
  where class_id='a3000000-0000-0000-0000-000000000002' and role='student' $$,$$ values (1::bigint) $$,
  'managed class students remain');
select results_eq($$ select count(*) from public.class_members
  where class_id='a3000000-0000-0000-0000-000000000002' and role='teacher' $$,$$ values (0::bigint) $$,
  'deleted teacher loses managed class membership');
select results_eq($$ select count(*) from public.organization_memberships
  where user_id='a1000000-0000-0000-0000-000000000002' $$,$$ values (0::bigint) $$,
  'organization membership is removed');
select results_eq($$ select count(*) from public.classes
  where teacher_id='a1000000-0000-0000-0000-000000000002' $$,$$ values (2::bigint) $$,
  'class records remain');
select results_eq($$ select count(*) from public.sessions
  where student_id='a1000000-0000-0000-0000-000000000003' $$,$$ values (2::bigint) $$,
  'student learning history remains');
select throws_ok($$ insert into public.class_members (class_id,user_id,role,status)
  values ('a3000000-0000-0000-0000-000000000001',
    'a1000000-0000-0000-0000-000000000003','student','pending') $$,
  '42501','This class is closed','closed standalone class cannot gain new members');
set local role authenticated;
select set_config('request.jwt.claim.sub','a1000000-0000-0000-0000-000000000002',true);
select throws_ok($$ insert into public.classes (teacher_id,name,join_code)
  values ('a1000000-0000-0000-0000-000000000002','Stale token class','GHJ-678') $$,
  '42501','This account has been deleted','stale JWT cannot create a class');

select * from finish();
rollback;
