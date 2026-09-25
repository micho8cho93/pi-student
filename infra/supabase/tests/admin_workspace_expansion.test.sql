begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(14);
insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
('c1000000-0000-0000-0000-000000000001','authenticated','authenticated','teacher@school.test','{}','{}'),
('c1000000-0000-0000-0000-000000000002','authenticated','authenticated','admin@school.test','{}','{}'),
('c1000000-0000-0000-0000-000000000003','authenticated','authenticated','student@other.test','{}','{}'),
('c1000000-0000-0000-0000-000000000004','authenticated','authenticated','operator@platform.test','{}','{}');
insert into public.organizations(id,slug,name) values('c2000000-0000-0000-0000-000000000001','expansion-test','Test');
insert into public.organization_memberships(organization_id,user_id,role) values
('c2000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','owner'),
('c2000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000002','admin');
insert into public.classes(id,teacher_id,organization_id,name) values('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000001','c2000000-0000-0000-0000-000000000001','Test class');
insert into public.class_members(class_id,user_id,role,status) values('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000003','student','active');
insert into public.platform_administrators(user_id) values('c1000000-0000-0000-0000-000000000004');
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-0000-0000-000000000002',true);
select lives_ok($$select public.class_capability_context('c3000000-0000-0000-0000-000000000001')$$,'Organization admin opens capabilities without teacher membership');
select lives_ok($$select public.create_class_project('c3000000-0000-0000-0000-000000000001','Project',null,'{"version":1}'::jsonb,'{}')$$,'Organization admin creates project');
select throws_ok($$select public.platform_users()$$,'42501','Platform administration required','Org admin cannot list platform users');
select set_config('request.jwt.claim.sub','c1000000-0000-0000-0000-000000000004',true);
select lives_ok($$select public.platform_analytics()$$,'Platform analytics loads');
select lives_ok($$select public.refresh_platform_security()$$,'Domain signals refresh');
select is((select count(*)::integer from public.security_alerts where class_id='c3000000-0000-0000-0000-000000000001'),1,'Domain mismatch detected');
select set_config('request.jwt.claim.sub','c1000000-0000-0000-0000-000000000003',true);
select lives_ok($$select public.record_chat_safety_signal('c3000000-0000-0000-0000-000000000001',array['threat_of_violence'])$$,'Student can report only own class signal');
select throws_ok($$select public.remove_class_student('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000003')$$,'42501','Class management required','Student cannot remove members');
select set_config('request.jwt.claim.sub','c1000000-0000-0000-0000-000000000002',true);
select lives_ok($$select public.remove_class_student('c3000000-0000-0000-0000-000000000001','c1000000-0000-0000-0000-000000000003')$$,'Admin can remove student');
select set_config('request.jwt.claim.sub','c1000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.record_chat_safety_signal('c3000000-0000-0000-0000-000000000001',array['threat_of_violence'])$$,'42501','Active student membership required','Removed student loses class access');
select set_config('request.jwt.claim.sub','c1000000-0000-0000-0000-000000000004',true);
select lives_ok($$select public.platform_prepare_user_deletion('c1000000-0000-0000-0000-000000000003')$$,'Platform can prepare deletion with session revocation');
select throws_ok($$select public.platform_prepare_user_deletion('c1000000-0000-0000-0000-000000000004')$$,'42501','Another platform administrator is required','Cannot delete self');
select lives_ok($$select public.platform_sync_user_profile('c1000000-0000-0000-0000-000000000001','Updated Teacher')$$,'Platform synchronizes profile from Auth');
select lives_ok($$select public.platform_security_alerts()$$,'Platform security resolves account and class labels');
select * from finish();
rollback;
