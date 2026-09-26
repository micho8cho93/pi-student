begin;
create extension if not exists pgtap;
select plan(9);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
  ('d1000000-0000-0000-0000-000000000001','authenticated','authenticated','evidence-teacher-a@example.test','{}','{}'),
  ('d1000000-0000-0000-0000-000000000002','authenticated','authenticated','evidence-teacher-b@example.test','{}','{}'),
  ('d1000000-0000-0000-0000-000000000003','authenticated','authenticated','evidence-student-a@example.test','{}','{}'),
  ('d1000000-0000-0000-0000-000000000004','authenticated','authenticated','evidence-student-b@example.test','{}','{}');
insert into public.classes(id,teacher_id,name,join_code) values
  ('d2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000001','Evidence A','EV-A-11'),
  ('d2000000-0000-0000-0000-000000000002','d1000000-0000-0000-0000-000000000002','Evidence B','EV-B-22');
insert into public.class_members(class_id,user_id,role,status) values
  ('d2000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000003','student','active'),
  ('d2000000-0000-0000-0000-000000000002','d1000000-0000-0000-000000000004','student','active');
insert into public.projects(id,class_id,name) values
  ('d3000000-0000-0000-0000-000000000001','d2000000-0000-0000-0000-000000000001','Project A'),
  ('d3000000-0000-0000-0000-000000000002','d2000000-0000-0000-0000-000000000002','Project B');
insert into public.sessions(id,student_id,class_id,project_id,started_at,ended_at) values
  ('d4000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000003','d2000000-0000-0000-0000-000000000001','d3000000-0000-0000-0000-000000000001',now()-interval '5 minutes',now()+interval '5 minutes'),
  ('d4000000-0000-0000-0000-000000000002','d1000000-0000-0000-0000-000000000004','d2000000-0000-0000-0000-000000000002','d3000000-0000-0000-0000-000000000002',now()-interval '5 minutes',now()+interval '5 minutes');

set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000003',true);
select is(public.replace_session_learning_evidence('d4000000-0000-0000-0000-000000000001',jsonb_build_array(jsonb_build_object(
  'id',repeat('a',64),'timestamp',now(),'category','test_failed','actor','student','source','observed',
  'summary','Test failed','references',jsonb_build_array('d5000000-0000-0000-0000-000000000001:1')))),1,'student saves a bounded derived event');
select results_eq($$ select count(*) from public.learning_evidence $$,$$ values (1::bigint) $$,'student reads own evidence');
select throws_ok($$ select public.replace_session_learning_evidence('d4000000-0000-0000-0000-000000000002','[]'::jsonb) $$,
  '42501','Student session required','student cannot replace another session');
select throws_ok($$ insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,summary,source_event_ids)
  values(repeat('b',64),'d4000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000003','d2000000-0000-0000-0000-000000000001','d3000000-0000-0000-0000-000000000001',now(),'test_failed','student','observed','const secret = raw code',array['d5000000-0000-0000-0000-000000000001:2']) $$,
  '23514',null,'database rejects raw code in summary');
select throws_ok($$ insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,summary,source_event_ids)
  values(repeat('c',64),'d4000000-0000-0000-0000-000000000001','d1000000-0000-0000-0000-000000000003','d2000000-0000-0000-0000-000000000001','d3000000-0000-0000-0000-000000000002',now(),'test_failed','student','observed','Test failed',array['d5000000-0000-0000-0000-000000000001:2']) $$,
  '42501',null,'RLS rejects a cross-project row');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000001',true);
select results_eq($$ select count(*) from public.learning_evidence $$,$$ values (1::bigint) $$,'assigned teacher sees student evidence');
select throws_ok($$ select public.replace_session_learning_evidence('d4000000-0000-0000-0000-000000000001','[]'::jsonb) $$,
  '42501','Student session required','teacher cannot replace student evidence');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','d1000000-0000-0000-0000-000000000002',true);
select results_eq($$ select count(*) from public.learning_evidence $$,$$ values (0::bigint) $$,'unassigned teacher cannot read evidence');
select results_eq($$ select count(*) from public.learning_evidence where project_id='d3000000-0000-0000-0000-000000000001' $$,$$ values (0::bigint) $$,'project filter cannot bypass teacher RLS');

select * from finish();
rollback;
