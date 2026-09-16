begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(18);

insert into auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) values
 ('71000000-0000-0000-0000-000000000001','authenticated','authenticated','governance-owner@example.test','{}','{}'),
 ('71000000-0000-0000-0000-000000000002','authenticated','authenticated','governance-teacher@example.test','{}','{}'),
 ('71000000-0000-0000-0000-000000000003','authenticated','authenticated','governance-student@example.test','{}','{}'),
 ('71000000-0000-0000-0000-000000000004','authenticated','authenticated','governance-operator@example.test','{}','{}'),
 ('71000000-0000-0000-0000-000000000005','authenticated','authenticated','governance-other@example.test','{}','{}');
insert into public.organizations(id,slug,name) values
 ('72000000-0000-0000-0000-000000000001','governance-a','Governance A'),
 ('72000000-0000-0000-0000-000000000002','governance-b','Governance B');
insert into public.organization_memberships(organization_id,user_id,role) values
 ('72000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000001','owner'),
 ('72000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000002','teacher'),
 ('72000000-0000-0000-0000-000000000002','71000000-0000-0000-0000-000000000005','owner');
insert into public.platform_administrators(user_id) values ('71000000-0000-0000-0000-000000000004');
insert into public.classes(id,organization_id,teacher_id,name,join_code) values
 ('73000000-0000-0000-0000-000000000001','72000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000001','Class A','GGG-234'),
 ('73000000-0000-0000-0000-000000000002','72000000-0000-0000-0000-000000000002','71000000-0000-0000-0000-000000000005','Class B','HHH-234');
insert into public.class_members(class_id,user_id,role,status) values
 ('73000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000002','teacher','active'),
 ('73000000-0000-0000-0000-000000000001','71000000-0000-0000-0000-000000000003','student','active');
insert into public.projects(id,class_id,name) values
 ('74000000-0000-0000-0000-000000000001','73000000-0000-0000-0000-000000000001','Project A'),
 ('74000000-0000-0000-0000-000000000002','73000000-0000-0000-0000-000000000002','Project B');

set local role authenticated;
select set_config('request.jwt.claim.sub','71000000-0000-0000-0000-000000000004',true);
select lives_ok($$ select public.set_organization_entitlement('72000000-0000-0000-0000-000000000001','model_governance',true) $$,'operator grants model governance');
select lives_ok($$ select public.set_organization_entitlement('72000000-0000-0000-0000-000000000001','budget_controls',true) $$,'operator grants budget controls');
select lives_ok($$ select public.set_organization_entitlement('72000000-0000-0000-0000-000000000001','usage_dashboard',true) $$,'operator grants usage dashboard');
select set_config('request.jwt.claim.sub','71000000-0000-0000-0000-000000000001',true);
select ok(set_config('governance.profile',public.save_model_profile('72000000-0000-0000-0000-000000000001',null,'General Coding','openai','gpt-test',array['low'],true,null)::text,true) <> '', 'owner creates approved model');
select lives_ok($$ select public.save_model_price('72000000-0000-0000-0000-000000000001',current_setting('governance.profile')::uuid,'2026-09',2000000,4000000,0,0) $$,'owner records immutable price version');
select lives_ok($$ select public.save_governance_policy('72000000-0000-0000-0000-000000000001','organization',null,null,'{"internet":false}'::jsonb,array['internet','models']) $$,'owner saves organization policy and delegation');
select results_eq($$ select count(*) from public.administrative_audit_events where organization_id='72000000-0000-0000-0000-000000000001' and target_type='model_profiles' $$,$$ values (1::bigint) $$,'model change audited');
select lives_ok($$ select public.save_organization_budget('72000000-0000-0000-0000-000000000001','organization',null,null,null,200,100,0.800,'block_ai') $$,'owner sets budget');
select set_config('request.jwt.claim.sub','71000000-0000-0000-0000-000000000002',true);
select lives_ok($$ select public.save_governance_policy('72000000-0000-0000-0000-000000000001','class','73000000-0000-0000-0000-000000000001',null,'{"internet":false}'::jsonb,'{}') $$,'teacher can restrict delegated class setting');
do $$ begin
 begin
  perform public.save_governance_policy('72000000-0000-0000-0000-000000000001','class','73000000-0000-0000-0000-000000000001',null,'{"terminal":false}'::jsonb,'{}');
  raise exception 'teacher changed undelegated setting';
 exception when insufficient_privilege then null; end;
end $$;
select pass('teacher cannot change undelegated setting');
select set_config('request.jwt.claim.sub','71000000-0000-0000-0000-000000000003',true);
select results_eq($$ select count(*) from public.approved_model_profiles('74000000-0000-0000-0000-000000000001') $$,$$ values (1::bigint) $$,'student sees only approved profile');
select is(public.governance_context('74000000-0000-0000-0000-000000000001')->>'organizationId','72000000-0000-0000-0000-000000000001','policy context has server-derived tenant');
do $$ begin
 begin
  insert into public.usage_ledger(id,organization_id,class_id,user_id,session_id,model_profile_id,provider,provider_model)
    values(gen_random_uuid(),'72000000-0000-0000-0000-000000000001','73000000-0000-0000-0000-000000000001',auth.uid(),gen_random_uuid(),
      current_setting('governance.profile')::uuid,'openai','gpt-test');
  raise exception 'student inserted ledger row';
 exception when insufficient_privilege then null; end;
end $$;
select pass('student has no direct ledger write');
select lives_ok($$ select public.record_reported_model_usage('76000000-0000-0000-0000-000000000001','74000000-0000-0000-0000-000000000001',
  '77000000-0000-0000-0000-000000000001','institution',current_setting('governance.profile'),100,0,0,0) $$,'student records approved model usage');
select results_eq($$ select input_tokens,known_cost_micros from public.usage_daily where organization_id='72000000-0000-0000-0000-000000000001' $$,
 $$ values (100::bigint,200::bigint) $$,'daily aggregate and versioned cost are correct');
select is((public.check_model_budget('74000000-0000-0000-0000-000000000001',current_setting('governance.profile')::uuid)->>'blocked')::boolean,true,'hard limit blocks subsequent request');
do $$ begin
 begin
  perform public.approved_model_profiles('74000000-0000-0000-0000-000000000002');
  raise exception 'student read other tenant model profiles';
 exception when insufficient_privilege then null; end;
end $$;
select pass('cross-tenant model access denied');
select set_config('request.jwt.claim.sub','71000000-0000-0000-0000-000000000004',true);
select results_eq($$ select known_cost_micros from public.platform_usage_summary() where organization_id='72000000-0000-0000-0000-000000000001' $$,
 $$ values (200::bigint) $$,'platform sees aggregate cost only');
select * from finish();
rollback;
