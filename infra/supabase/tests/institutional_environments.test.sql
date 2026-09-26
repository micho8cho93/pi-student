begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(39);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('81000000-0000-0000-0000-000000000001','authenticated','authenticated','env-owner@example.test','{}','{}'),
 ('81000000-0000-0000-0000-000000000002','authenticated','authenticated','env-teacher@example.test','{}','{}'),
 ('81000000-0000-0000-0000-000000000003','authenticated','authenticated','env-student@example.test','{}','{}'),
 ('81000000-0000-0000-0000-000000000004','authenticated','authenticated','env-other@example.test','{}','{}');
insert into public.organizations(id,slug,name) values
 ('82000000-0000-0000-0000-000000000001','env-org-a','Environment A'),
 ('82000000-0000-0000-0000-000000000002','env-org-b','Environment B');
insert into public.organization_memberships(organization_id,user_id,role) values
 ('82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001','owner'),
 ('82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000002','teacher'),
 ('82000000-0000-0000-0000-000000000002','81000000-0000-0000-0000-000000000004','owner');
insert into public.classes(id,organization_id,teacher_id,name,join_code) values
 ('83000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001','Class A','JJJ-234'),
 ('83000000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000002','81000000-0000-0000-0000-000000000004','Class B','KKK-234');
insert into public.class_members(class_id,user_id,role,status) values
 ('83000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000002','teacher','active'),
 ('83000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000003','student','active');
insert into public.projects(id,class_id,name) values
 ('84000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000001','Project A'),
 ('84000000-0000-0000-0000-000000000003','83000000-0000-0000-0000-000000000001','Project C'),
 ('84000000-0000-0000-0000-000000000002','83000000-0000-0000-0000-000000000002','Project B');

set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select ok(set_config('env.profile',public.save_sandbox_profile('82000000-0000-0000-0000-000000000001',null,'Base Python',
  jsonb_build_object('runtime','python','runtimeVersion','3.12','packages','[]'::jsonb,'imageDigest','sha256:'||repeat('a',64),'allowedHosts','[]'::jsonb,'metadata','{}'::jsonb))::text,true)<>'','owner creates immutable profile');
select throws_ok($$ select public.save_sandbox_profile('82000000-0000-0000-0000-000000000001',null,'Unpinned',
  jsonb_build_object('runtime','python','runtimeVersion','3.12','packages','[{"name":"numpy","version":"latest"}]'::jsonb,
    'imageDigest','sha256:'||repeat('a',64),'allowedHosts','[]'::jsonb,'metadata','{}'::jsonb)) $$,
  '22023','Packages require pinned versions and SHA-256 integrity','unreproducible package refused');
select lives_ok($$ select public.assign_sandbox_profile('82000000-0000-0000-0000-000000000001','organization',null,null,current_setting('env.profile')::uuid,1) $$,'pending profile assignment is persisted for truthful status reporting');
select lives_ok($$ select public.create_organization_dataset('82000000-0000-0000-0000-000000000001','Course','1','abcdefghijklmnop',repeat('b',64),4096,'organization',null,null,'/datasets/course','read-only') $$,'read-only dataset can be registered');
select results_eq($$ select access from public.organization_datasets where organization_id='82000000-0000-0000-0000-000000000001' $$,$$ values ('read-only'::text) $$,'dataset registered read-only');
select throws_ok($$ select public.create_organization_dataset('82000000-0000-0000-0000-000000000001','Escape','1','abcdefghijklmnop',repeat('b',64),4096,'organization',null,null,'/datasets/../private','read-only') $$,'23514',null,'path traversal is refused');
select throws_ok($$ select public.create_organization_dataset('82000000-0000-0000-0000-000000000001','Other','1','abcdefghijklmnop',repeat('b',64),4096,'class','83000000-0000-0000-0000-000000000002',null,'/datasets/other','read-only') $$,'42501','Class belongs to another organization','cross-tenant dataset refused');
select lives_ok($$ select public.save_organization_skill('82000000-0000-0000-0000-000000000001',null,'Guide','Reviewed','1.0.0','sha256:'||repeat('c',64),'organization',null,null,array['filesystem'],'pending',false) $$,'skill imported disabled');
select throws_ok($$ select public.save_organization_skill('82000000-0000-0000-0000-000000000001',null,'Bad','Unreviewed','1.0.0','sha256:'||repeat('c',64),'organization',null,null,array['secrets'],'pending',true) $$,'22023','Approve before enabling','unreviewed skill cannot be enabled');
select ok(set_config('env.mcp',public.save_organization_mcp('82000000-0000-0000-0000-000000000001',null,'Course API','1.0.0','http','https://course.example.test/api',null,'vault://course/token',array['course.example.test'],'organization',null,null,array['network'],'approved',true)::text,true)<>'','admin creates approved MCP with opaque secret reference');
select results_eq($$ select count(*) from public.administrative_audit_events where organization_id='82000000-0000-0000-0000-000000000001' and action in ('sandbox_profile.created','skill.imported','mcp.created') $$,$$ values (3::bigint) $$,'registry changes audited without credential values');
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000002',true);
select lives_ok($$ select public.set_teacher_extension_enabled('83000000-0000-0000-0000-000000000001',null,'mcp',current_setting('env.mcp')::uuid,true) $$,'teacher grants an approved MCP to the class');
select lives_ok($$ select public.set_teacher_extension_enabled('83000000-0000-0000-0000-000000000001',null,'mcp',current_setting('env.mcp')::uuid,false) $$,'teacher can revoke an approved MCP for the class');
set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000003',true);
select is(jsonb_array_length(public.resolve_institutional_environment('84000000-0000-0000-0000-000000000001')->'mcps'),0,'runtime removes a teacher-revoked MCP');
set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000002',true);
select lives_ok($$ select public.set_teacher_extension_enabled('83000000-0000-0000-0000-000000000001',null,'mcp',current_setting('env.mcp')::uuid,true) $$,'teacher can restore the MCP from the same control path');
set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000003',true);
select is(jsonb_array_length(public.resolve_institutional_environment('84000000-0000-0000-0000-000000000001')->'mcps'),1,'runtime converges after the teacher restores the MCP');
select throws_ok($$ select public.save_sandbox_profile('82000000-0000-0000-0000-000000000001',null,'Teacher', '{}'::jsonb) $$,'42501','Organization administrator required','teacher cannot mint profile');
select throws_ok($$ select public.save_organization_mcp('82000000-0000-0000-0000-000000000001',null,'Teacher MCP','1','http','https://course.example.test',null,null,'{}','organization',null,null,'{}','approved',true) $$,'42501','Organization administrator required','teacher cannot bypass extension review');
set local role service_role;
select lives_ok($$ select public.mark_sandbox_profile_build('82000000-0000-0000-0000-000000000001',current_setting('env.profile')::uuid,1,'ready') $$,'trusted builder marks verified image ready');
set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select lives_ok($$ select public.assign_sandbox_profile('82000000-0000-0000-0000-000000000001','organization',null,null,current_setting('env.profile')::uuid,1) $$,'organization default assigned');
select ok(set_config('env.class_profile',public.save_sandbox_profile('82000000-0000-0000-0000-000000000001',null,'Class Node',
  jsonb_build_object('runtime','node','runtimeVersion','22','packages','[]'::jsonb,'imageDigest','sha256:'||repeat('d',64),'allowedHosts','[]'::jsonb,'metadata','{}'::jsonb))::text,true)<>'','class profile revision created');
set local role service_role;
select lives_ok($$ select public.mark_sandbox_profile_build('82000000-0000-0000-0000-000000000001',current_setting('env.class_profile')::uuid,1,'ready') $$,'class image builder verifies revision');
set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select lives_ok($$ select public.assign_sandbox_profile('82000000-0000-0000-0000-000000000001','class','83000000-0000-0000-0000-000000000001',null,current_setting('env.class_profile')::uuid,1) $$,'class override assigned');
select lives_ok($$ select public.assign_sandbox_profile('82000000-0000-0000-0000-000000000001','project','83000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001',current_setting('env.profile')::uuid,1) $$,'project override assigned');
select ok(set_config('env.failed_profile',public.save_sandbox_profile('82000000-0000-0000-0000-000000000001',null,'Failed Node',
  jsonb_build_object('runtime','node','runtimeVersion','22','packages','[]'::jsonb,'imageDigest','sha256:'||repeat('e',64),'allowedHosts','[]'::jsonb,'metadata','{}'::jsonb))::text,true)<>'','failed revision is visible to administrators');
set local role service_role;
select lives_ok($$ select public.mark_sandbox_profile_build('82000000-0000-0000-0000-000000000001',current_setting('env.failed_profile')::uuid,1,'failed') $$,'trusted builder records failed state');
set local role authenticated;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select throws_ok($$ select public.assign_sandbox_profile('82000000-0000-0000-0000-000000000001','organization',null,null,current_setting('env.failed_profile')::uuid,1) $$,'22023','Profile is not assignable in its current state','failed profile cannot be assigned');
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000003',true);
select is((public.resolve_institutional_environment('84000000-0000-0000-0000-000000000001')->'profile'->>'version')::int,1,'student resolves one ready profile');
select is(public.resolve_institutional_environment('84000000-0000-0000-0000-000000000001')->'profile'->>'id',current_setting('env.profile'),'project takes precedence over class');
select is(public.resolve_institutional_environment('84000000-0000-0000-0000-000000000003')->'profile'->>'id',current_setting('env.class_profile'),'class takes precedence over organization');
select is(public.resolve_institutional_environment('84000000-0000-0000-0000-000000000001')->>'environmentStatus','ready','runtime receives verified build status');
select ok(public.resolve_institutional_environment('84000000-0000-0000-0000-000000000001')->'requiredCapabilities' ? 'managed-profile','runtime receives required capability handshake');
select is(jsonb_array_length(public.resolve_institutional_environment('84000000-0000-0000-0000-000000000001')->'skills'),0,'disabled skill unavailable');
select ok(not (public.resolve_institutional_environment('84000000-0000-0000-0000-000000000001')->'mcps'->0 ? 'secret_reference'),'student MCP inventory has no secret reference');
select lives_ok($$ select public.record_execution_audit_event('85000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','83000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','session-1','mcp.list','allowed',current_setting('env.mcp')::uuid,'network','implement','authorized','gondolin','ready') $$,'student execution decision is recorded through the RPC');
-- execution_audit_admin_read hides audit rows from the student who wrote them.
select is((select count(*) from public.execution_audit_events where event_id='85000000-0000-0000-0000-000000000001'),0::bigint,'student cannot read execution audit rows');
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select is((select count(*) from public.execution_audit_events where event_id='85000000-0000-0000-0000-000000000001'),1::bigint,'execution audit stores one safe decision');
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000003',true);
select throws_ok($$ select public.record_execution_audit_event('85000000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000002','83000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','session-2','mcp.list','allowed',current_setting('env.mcp')::uuid,'network','implement','authorized','gondolin','ready') $$,'42501','Managed student project required','audit tenant identifiers cannot be substituted');
select throws_ok($$ select public.resolve_institutional_environment('84000000-0000-0000-0000-000000000002') $$,'42501','Managed project access required','other tenant environment unavailable');
select * from finish();
rollback;
