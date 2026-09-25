begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(14);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('81000000-0000-0000-0000-000000000001','authenticated','authenticated','reserve-owner@example.test','{}','{}'),
 ('81000000-0000-0000-0000-000000000002','authenticated','authenticated','reserve-teacher@example.test','{}','{}'),
 ('81000000-0000-0000-0000-000000000003','authenticated','authenticated','reserve-student@example.test','{}','{}'),
 ('81000000-0000-0000-0000-000000000004','authenticated','authenticated','reserve-operator@example.test','{}','{}');
insert into public.organizations(id,slug,name) values ('82000000-0000-0000-0000-000000000001','reserve-a','Reserve A');
insert into public.organization_memberships(organization_id,user_id,role) values
 ('82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001','owner'),
 ('82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000002','teacher');
insert into public.platform_administrators(user_id) values ('81000000-0000-0000-0000-000000000004');
insert into public.classes(id,organization_id,teacher_id,name,join_code) values
 ('83000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001','Reserve class','RRR-234');
insert into public.class_members(class_id,user_id,role,status) values
 ('83000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000002','teacher','active'),
 ('83000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000003','student','active');
insert into public.projects(id,class_id,name) values
 ('84000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000001','Reserve project');

select ok(private.validate_capability_policy('{"schemaVersion":1,"reasoningLevels":["off"],"models":[],"fileEditing":true,"terminal":true,"dependencyInstallation":true,"internet":true,"desktopExport":true,"imageUploads":true,"fileUploads":true,"reflection":true,"limits":{"minutes":null,"turns":null,"tokens":null,"cost":null},"accessibility":{"dictation":true,"cloudDictation":true,"readAloud":false,"simplifiedVocabulary":false,"readableFormatting":false}}'::jsonb),
 'policies saved before the tutoring reserve stay valid');
select ok(not private.validate_capability_policy('{"schemaVersion":1,"reasoningLevels":["off"],"models":[],"fileEditing":true,"terminal":true,"dependencyInstallation":true,"internet":true,"desktopExport":true,"imageUploads":true,"fileUploads":true,"reflection":true,"limits":{"minutes":null,"turns":null,"tokens":null,"cost":null,"tutoringTurns":0},"accessibility":{"dictation":true,"cloudDictation":true,"readAloud":false,"simplifiedVocabulary":false,"readableFormatting":false}}'::jsonb),
 'tutoring reserve must be positive or null');

set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000004',true);
select public.set_organization_entitlement('82000000-0000-0000-0000-000000000001','model_governance',true);
select public.set_organization_entitlement('82000000-0000-0000-0000-000000000001','budget_controls',true);
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select set_config('reserve.profile',public.save_model_profile('82000000-0000-0000-0000-000000000001',null,'Tutor','openai','gpt-test',array['low'],true,null)::text,true);
select public.save_organization_providers('82000000-0000-0000-0000-000000000001',array['openai']);
select lives_ok($$ select public.save_governance_policy('82000000-0000-0000-0000-000000000001','organization',null,null,
 '{"limits":{"turns":20,"tutoringTurns":10}}'::jsonb,array['limits.tutoringTurns']) $$,'organization reserves tutoring and delegates it');
select lives_ok($$ select public.save_organization_budget('82000000-0000-0000-0000-000000000001','organization',null,null,null,null,60000,0.800,'block_ai',0.5) $$,
 'owner reserves half of the monthly budget for tool-free help');
select is((select assistance_reserve_fraction from public.organization_budgets where organization_id='82000000-0000-0000-0000-000000000001'),0.5::numeric(4,3),'reserve is stored on the budget');
select throws_ok($$ select public.save_organization_budget('82000000-0000-0000-0000-000000000001','organization',null,null,null,null,60000,0.800,'block_ai',1) $$,
 '23514',null,'reserve cannot cover the whole budget');

select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000002',true);
select lives_ok($$ select public.save_governance_policy('82000000-0000-0000-0000-000000000001','class','83000000-0000-0000-0000-000000000001',null,
 '{"limits":{"tutoringTurns":4}}'::jsonb,'{}') $$,'teacher narrows the delegated tutoring reserve');
select is(public.class_capability_context('83000000-0000-0000-0000-000000000001')#>>'{settings,limits,tutoringTurns}','4','smaller reserve wins in the hierarchy');
select throws_ok($$ select public.save_governance_policy('82000000-0000-0000-0000-000000000001','class','83000000-0000-0000-0000-000000000001',null,
 '{"limits":{"turns":50}}'::jsonb,'{}') $$,'42501',null,'teacher cannot change the undelegated agent limit');

set local role service_role;
-- 36,096 reserved tokens of 60,000 is past the agent share (50%) but inside the whole budget.
select is(public.gateway_reserve_model_request('81000000-0000-0000-0000-000000000003','84000000-0000-0000-0000-000000000001',
 current_setting('reserve.profile')::uuid,'low',32000,4096,true)->>'action','assistance_only','gateway refuses tool-using requests inside the reserve');
select set_config('reserve.reservation',public.gateway_reserve_model_request('81000000-0000-0000-0000-000000000003','84000000-0000-0000-0000-000000000001',
 current_setting('reserve.profile')::uuid,'low',32000,4096,false)->>'reservationId',true);
select ok(current_setting('reserve.reservation') <> '','gateway admits tool-free tutoring inside the reserve');
select lives_ok($$ select public.gateway_settle_model_request(current_setting('reserve.reservation')::uuid,
 '87000000-0000-0000-0000-000000000001',31000,0,0,0) $$,'tutoring usage settles on the same ledger');

set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000003',true);
select is((public.check_model_budget('84000000-0000-0000-0000-000000000001',current_setting('reserve.profile')::uuid)->>'agentBlocked')::boolean,true,
 'preflight reports the agent lane exhausted');
select is((public.check_model_budget('84000000-0000-0000-0000-000000000001',current_setting('reserve.profile')::uuid)->>'blocked')::boolean,false,
 'preflight keeps tutoring available');

select * from finish();
rollback;
