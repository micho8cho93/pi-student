begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(15);

insert into auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
  ('b1000000-0000-0000-0000-000000000001','authenticated','authenticated','controls-teacher@example.test','{}','{}'),
  ('b1000000-0000-0000-0000-000000000002','authenticated','authenticated','controls-other@example.test','{}','{}'),
  ('b1000000-0000-0000-0000-000000000003','authenticated','authenticated','controls-student@example.test','{}','{}');
insert into public.organizations (id,slug,name) values
  ('b2000000-0000-0000-0000-000000000001','teacher-controls-test','Controls School');
insert into public.organization_memberships (organization_id,user_id,role) values
  ('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','owner'),
  ('b2000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000002','teacher');
insert into public.classes (id,teacher_id,organization_id,name,join_code) values
  ('b3000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001','A','ABC-234'),
  ('b3000000-0000-0000-0000-000000000002','b1000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000001','B','DEF-567');
insert into public.projects (id,class_id,name) values
  ('b4000000-0000-0000-0000-000000000001','b3000000-0000-0000-0000-000000000001','Project A'),
  ('b4000000-0000-0000-0000-000000000002','b3000000-0000-0000-0000-000000000002','Project B');
insert into public.class_members (class_id,user_id,role,status) values
  ('b3000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000003','student','active');
insert into public.organization_skills (id,organization_id,name,version,artifact_digest,enabled,approval_status,scope,class_id,project_id) values
  ('b5000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001','Class skill','1','sha256:'||repeat('a',64),true,'approved','organization',null,null),
  ('b5000000-0000-0000-0000-000000000002','b2000000-0000-0000-0000-000000000001','Project skill','1','sha256:'||repeat('b',64),true,'approved','project','b3000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001');
insert into public.organization_mcps (id,organization_id,name,version,transport,endpoint,enabled,approval_status) values
  ('b6000000-0000-0000-0000-000000000001','b2000000-0000-0000-0000-000000000001','School MCP','1','http','https://mcp.example.test/api',true,'approved');
insert into public.sessions (id,student_id,class_id,project_id,started_at,ended_at,total_tokens,duration_seconds) values
  ('b7000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000003','b3000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001',now(),now(),240,120);

set local role authenticated;
select set_config('request.jwt.claim.sub','b1000000-0000-0000-0000-000000000001',true);
select results_eq($$ select jsonb_array_length(public.teacher_extension_catalog('b3000000-0000-0000-0000-000000000001',null)) $$,
  $$ values (2) $$, 'class catalog excludes project-only entries');
select results_eq($$ select jsonb_array_length(public.teacher_extension_catalog('b3000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001')) $$,
  $$ values (3) $$, 'project catalog includes applicable entries');
select ok(position('mcp.example.test' in public.teacher_extension_catalog('b3000000-0000-0000-0000-000000000001',null)::text) = 0,
  'catalog does not expose an MCP endpoint');
select throws_ok($$ select public.set_teacher_extension_enabled('b3000000-0000-0000-0000-000000000001',null,'skill','b5000000-0000-0000-0000-000000000002',false) $$,
  '42501','Extension unavailable for this target','project-only skill cannot be changed for entire class');
select results_eq($$ select jsonb_array_length(public.resolve_institutional_environment('b4000000-0000-0000-0000-000000000001')->'skills') $$,
  $$ values (0) $$, 'organization approval alone does not expose a skill');
select lives_ok($$ select public.set_teacher_extension_enabled('b3000000-0000-0000-0000-000000000001',null,'skill','b5000000-0000-0000-0000-000000000001',true) $$,
  'teacher grants an approved skill to the class');
select lives_ok($$ select public.set_teacher_extension_enabled('b3000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000001','mcp','b6000000-0000-0000-0000-000000000001',false) $$,
  'teacher can block an approved MCP for one project');
select results_eq($$ select jsonb_array_length(public.resolve_institutional_environment('b4000000-0000-0000-0000-000000000001')->'skills') $$,
  $$ values (1) $$, 'class grant exposes approved skill to student environment');
select lives_ok($$ select public.set_teacher_extension_enabled('b3000000-0000-0000-0000-000000000001',null,'skill','b5000000-0000-0000-0000-000000000001',false) $$,
  'teacher can revoke the class skill grant');
select results_eq($$ select jsonb_array_length(public.resolve_institutional_environment('b4000000-0000-0000-0000-000000000001')->'mcps') $$,
  $$ values (0) $$, 'project block removes MCP from student environment');
select results_eq($$ select (public.teacher_usage_summary('b3000000-0000-0000-0000-000000000001',null,current_date)->>'tokens')::integer $$,
  $$ values (240) $$, 'teacher sees usage for own class');
select throws_ok($$ select public.teacher_usage_summary('b3000000-0000-0000-0000-000000000001','b4000000-0000-0000-0000-000000000002',current_date) $$,
  '42501','Project outside class','usage cannot cross into another class project');

select set_config('request.jwt.claim.sub','b1000000-0000-0000-0000-000000000002',true);
select throws_ok($$ select public.teacher_extension_catalog('b3000000-0000-0000-0000-000000000001',null) $$,
  '42501','Teacher access required','other teacher cannot view class extension catalog');
select throws_ok($$ select public.teacher_usage_summary('b3000000-0000-0000-0000-000000000001',null,current_date) $$,
  '42501','Teacher access required','other teacher cannot view class usage');
select set_config('request.jwt.claim.sub','b1000000-0000-0000-0000-000000000003',true);
select throws_ok($$ select public.set_teacher_extension_enabled('b3000000-0000-0000-0000-000000000001',null,'skill','b5000000-0000-0000-0000-000000000001',true) $$,
  '42501','Teacher access required','student cannot change extension controls');

select * from finish();
rollback;
