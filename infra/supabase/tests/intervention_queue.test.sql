begin;
create extension if not exists pgtap;
select plan(25);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('e1000000-0000-0000-0000-000000000001','authenticated','authenticated','queue-teacher-a@example.test','{}','{}'),
 ('e1000000-0000-0000-0000-000000000002','authenticated','authenticated','queue-teacher-b@example.test','{}','{}'),
 ('e1000000-0000-0000-0000-000000000003','authenticated','authenticated','queue-student-a@example.test','{}','{}'),
 ('e1000000-0000-0000-0000-000000000004','authenticated','authenticated','queue-student-b@example.test','{}','{}');
insert into public.classes(id,teacher_id,name,join_code) values
 ('e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','Queue A','QUA-222'),
 ('e2000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000002','Queue B','QUB-333');
insert into public.class_members(class_id,user_id,role,status) values
 ('e2000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000003','student','active'),
 ('e2000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000004','student','active');
insert into public.projects(id,class_id,name) values
 ('e3000000-0000-0000-0000-000000000001','e2000000-0000-0000-0000-000000000001','Queue project A'),
 ('e3000000-0000-0000-0000-000000000002','e2000000-0000-0000-0000-000000000002','Queue project B'),
 ('e3000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','Queue project A2');
insert into public.sessions(id,student_id,class_id,project_id,started_at,ended_at,total_tokens) values
 ('e4000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000001',now()-interval '2 hours',now()-interval '1 hour',900000),
 ('e4000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000003',now()-interval '3 days',now()-interval '2 days',0),
 ('e4000000-0000-0000-0000-000000000003','e1000000-0000-0000-0000-000000000004','e2000000-0000-0000-0000-000000000002','e3000000-0000-0000-0000-000000000002',now()-interval '2 hours',now()-interval '1 hour',0),
 ('e4000000-0000-0000-0000-000000000004','e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000001',now()-interval '2 hours',now()-interval '1 hour',999999);

-- Four failures and three agent edits, all in one session. The other sessions
-- include a token-heavy empty session and a separate project with one pass.
insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,summary,source_event_ids)
select repeat(md5('queue-fail-'||n::text),2), 'e4000000-0000-0000-0000-000000000001',
 'e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001',
 'e3000000-0000-0000-0000-000000000001',now()-interval '90 minutes'+n*interval '1 minute',
 'test_failed','student','observed','Test failed',array['e5000000-0000-0000-0000-000000000001:'||n::text]
from generate_series(1,4) n;
insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,summary,source_event_ids)
select repeat(md5('queue-agent-'||n::text),2), 'e4000000-0000-0000-0000-000000000001',
 'e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001',
 'e3000000-0000-0000-0000-000000000001',now()-interval '80 minutes'+n*interval '1 minute',
 'agent_edit','agent','observed','Agent edited app.ts',array['e5000000-0000-0000-0000-000000000001:'||(n+10)::text]
from generate_series(1,3) n;
insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,summary,source_event_ids)
values (repeat(md5('queue-old-pass'),2),'e4000000-0000-0000-0000-000000000002','e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000003',now()-interval '60 hours','test_passed','student','observed','Tests passed',array['e5000000-0000-0000-0000-000000000002:1']);
insert into public.sessions(id,student_id,class_id,project_id,started_at,ended_at,effective_policy)
select 'e4000000-0000-0000-0000-000000000005','e1000000-0000-0000-0000-000000000003',p.class_id,p.id,
 now()-interval '3 days',now()-interval '2 days',
 jsonb_build_object('projectId',p.id,'version',1,'settings',jsonb_set(p.capability_policy,'{reflection}','false'::jsonb))
from public.projects p where p.id='e3000000-0000-0000-0000-000000000001';
insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,summary,source_event_ids)
values (repeat(md5('queue-no-reflection-required'),2),'e4000000-0000-0000-0000-000000000005','e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000001',now()-interval '60 hours','test_passed','student','observed','Tests passed',array['e5000000-0000-0000-0000-000000000005:1']);

set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000002',true);
select throws_ok($$ select public.refresh_teacher_interventions('e2000000-0000-0000-0000-000000000001') $$,'42501','Teacher access required','unassigned teacher cannot refresh another class');
select results_eq($$ select count(*) from public.intervention_items where class_id='e2000000-0000-0000-0000-000000000001' $$,$$ values (0::bigint) $$,'unassigned teacher sees no queue rows');
select set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000003',true);
select throws_ok($$ select public.refresh_teacher_interventions('e2000000-0000-0000-0000-000000000001') $$,'42501','Teacher access required','student cannot refresh queue');
select throws_ok($$ insert into public.intervention_items(class_id,project_id,student_id,session_id,category,priority,explanation,evidence) values
 ('e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000003','e4000000-0000-0000-0000-000000000001','repeated_failures','high','raw prompt','{}') $$,
 '42501',null,'students cannot write queue rows or raw explanations');

select set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000001',true);
select is(public.refresh_teacher_interventions('e2000000-0000-0000-0000-000000000001'),3,'three deterministic conditions fire');
select results_eq($$ select category from public.intervention_items where class_id='e2000000-0000-0000-0000-000000000001' order by category $$,
 $$ values ('agent_edit_balance'::text),('missing_reflection'::text),('repeated_failures'::text) $$,'only evidence-backed categories fire');
select results_eq($$ select count(*) from public.intervention_items where session_id='e4000000-0000-0000-0000-000000000004' $$,$$ values (0::bigint) $$,'token count alone never creates an intervention');
select results_eq($$ select count(*) from public.intervention_items where session_id='e4000000-0000-0000-0000-000000000005' $$,$$ values (0::bigint) $$,'reflection-disabled session does not create missing-reflection item');
select results_eq($$ select count(*) from public.intervention_items where project_id='e3000000-0000-0000-0000-000000000003' $$,$$ values (1::bigint) $$,'project evidence remains isolated');
select is(public.refresh_teacher_interventions('e2000000-0000-0000-0000-000000000001'),3,'refresh recomputes without duplicate creation');
select results_eq($$ select count(*) from public.intervention_items $$,$$ values (3::bigint) $$,'unique session and category suppress duplicates');
reset role;
insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,summary,source_event_ids)
values (repeat(md5('queue-fail-5'),2),'e4000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000001',now()-interval '82 minutes','test_failed','student','observed','Test failed',array['e5000000-0000-0000-0000-000000000001:5']);
set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000001',true);
select is(public.refresh_teacher_interventions('e2000000-0000-0000-0000-000000000001'),3,'fifth failure increases priority without a duplicate');
select results_eq($$ select priority from public.intervention_items where category='repeated_failures' $$,$$ values ('high'::text) $$,'high priority has a visible five-failure threshold');
update public.intervention_items set status='dismissed',teacher_note='Reviewed with classwork.' where category='agent_edit_balance';
select results_eq($$ select count(*) from public.intervention_items where status='dismissed' and resolved_at is not null $$,$$ values (1::bigint) $$,'dismissal records closure time');
select is(public.refresh_teacher_interventions('e2000000-0000-0000-0000-000000000001'),3,'closed item remains eligible but not reopened');
select results_eq($$ select status from public.intervention_items where category='agent_edit_balance' $$,$$ values ('dismissed'::text) $$,'dismissed item stays dismissed');
update public.intervention_items set status='resolved' where category='missing_reflection';
select results_eq($$ select status from public.intervention_items where category='missing_reflection' $$,$$ values ('resolved'::text) $$,'teacher can resolve an item');
select throws_ok($$ update public.intervention_items set explanation='student is lazy' where category='repeated_failures' $$,'42501',null,'teacher cannot overwrite generated explanation');
select results_eq($$ select count(*) from public.intervention_items where explanation ~* 'prompt|code|lazy' $$,$$ values (0::bigint) $$,'queue holds no unsupported labels or raw prompts');

reset role;
insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,summary,source_event_ids)
values (repeat(md5('queue-new-pass'),2),'e4000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000003','e2000000-0000-0000-0000-000000000001','e3000000-0000-0000-0000-000000000001',now()-interval '61 minutes','test_passed','student','observed','Tests passed',array['e5000000-0000-0000-0000-000000000001:20']);
set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000001',true);
select is(public.refresh_teacher_interventions('e2000000-0000-0000-0000-000000000001'),2,'later pass clears repeated failure condition');
select results_eq($$ select status from public.intervention_items where category='repeated_failures' $$,$$ values ('resolved'::text) $$,'cleared failure signal closes the open item');
select results_eq($$ select count(*) from public.intervention_items where status='open' $$,$$ values (0::bigint) $$,'no stale open items remain');
select set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000002',true);
select results_eq($$ select count(*) from public.intervention_items $$,$$ values (0::bigint) $$,'other class teacher cannot see closed or open items');

reset role;
insert into public.session_reflections(session_id,student_id,accomplished,important_decision,still_unclear,next_step,confirmed_at)
values('e4000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000003','','','','',now()-interval '60 minutes');
set local role authenticated;
select set_config('request.jwt.claim.sub','e1000000-0000-0000-0000-000000000001',true);
select is(public.refresh_teacher_interventions('e2000000-0000-0000-0000-000000000001'),3,'confirmed reflection and pass create a review candidate');
select results_eq($$ select category,priority from public.intervention_items where status='open' $$,
 $$ values ('ready_for_review'::text,'low'::text) $$,'review readiness is low priority and explains recorded evidence');

select * from finish();
rollback;
