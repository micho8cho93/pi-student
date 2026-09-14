begin;
create extension if not exists pgtap;
select plan(14);

insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
values
  ('10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'teacher-a@example.test', '', now(), now(), now(), '{}', '{}'),
  ('10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'teacher-b@example.test', '', now(), now(), now(), '{}', '{}'),
  ('20000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'student-a@example.test', '', now(), now(), now(), '{}', '{}'),
  ('20000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'student-b@example.test', '', now(), now(), now(), '{}', '{}'),
  ('20000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'student-c@example.test', '', now(), now(), now(), '{}', '{}');

insert into public.classes (id, teacher_id, name, join_code)
values
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Teacher A class', 'ABC-234'),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Teacher B class', 'DEF-567'),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'Expired class', 'GHJ-678'),
  ('30000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'Revoked class', 'KLM-789');
update public.classes set join_code_expires_at = now() - interval '1 minute' where id = '30000000-0000-0000-0000-000000000003';
update public.classes set join_enabled = false where id = '30000000-0000-0000-0000-000000000004';

insert into public.class_members (class_id, user_id, role, status)
values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'student', 'active'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'student', 'active');

insert into public.sessions (id, student_id, class_id, started_at, ended_at)
values
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', now(), now()),
  ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', true);
select results_eq(
  $$ select count(*) from public.sessions where id = '40000000-0000-0000-0000-000000000001' $$,
  $$ values (1::bigint) $$,
  'student A can read student A session'
);
select results_eq(
  $$ select count(*) from public.sessions where id = '40000000-0000-0000-0000-000000000002' $$,
  $$ values (0::bigint) $$,
  'student A cannot read student B session'
);
select results_eq(
  $$ select count(*) from pg_policies where schemaname = 'public' and tablename = 'sessions' and policyname = 'sessions_insert_self' and cmd = 'INSERT' $$,
  $$ values (1::bigint) $$,
  'sessions expose only the self-insert RLS policy'
);
select results_eq(
  $$ select count(*) from pg_policies where schemaname = 'public' and tablename = 'class_members' and cmd = 'INSERT' $$,
  $$ values (0::bigint) $$,
  'class memberships cannot be inserted directly by students'
);
select results_eq(
  $$ select count(*) from public.join_class('ZZZ-999') $$,
  $$ values (0::bigint) $$,
  'invalid join code is rejected'
);
select results_eq(
  $$ select count(*) from public.join_class('GHJ-678') $$,
  $$ values (0::bigint) $$,
  'expired join code is rejected'
);
select results_eq(
  $$ select count(*) from public.join_class('KLM-789') $$,
  $$ values (0::bigint) $$,
  'revoked join code is rejected'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', true);
select results_eq(
  $$ select membership_status from public.join_class('ABC-234') $$,
  $$ values ('pending'::public.membership_status) $$,
  'valid join creates a pending membership'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
select lives_ok(
  $$ insert into public.classes (id, name, join_code) values ('30000000-0000-0000-0000-000000000005', 'Created through teacher RLS', 'NPQ-823') $$,
  'authenticated teacher can create a class'
);
select results_eq(
  $$ select count(*) from public.classes where id = '30000000-0000-0000-0000-000000000001' $$,
  $$ values (1::bigint) $$,
  'teacher A can read teacher A class'
);
select lives_ok(
  $$ update public.class_members set status = 'active' where class_id = '30000000-0000-0000-0000-000000000001' and user_id = '20000000-0000-0000-0000-000000000003' $$,
  'teacher can approve a pending student'
);
select results_eq(
  $$ select count(*) from public.classes where id = '30000000-0000-0000-0000-000000000002' $$,
  $$ values (0::bigint) $$,
  'teacher A cannot read teacher B class'
);
select results_eq(
  $$ select count(*) from public.sessions where id = '40000000-0000-0000-0000-000000000001' $$,
  $$ values (1::bigint) $$,
  'teacher A can read a student session in teacher A class'
);
select results_eq(
  $$ select count(*) from public.sessions where id = '40000000-0000-0000-0000-000000000002' $$,
  $$ values (0::bigint) $$,
  'teacher A cannot read a student session in teacher B class'
);

select * from finish();
rollback;
