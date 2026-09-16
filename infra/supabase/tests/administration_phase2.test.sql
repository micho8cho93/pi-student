begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(38);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data) values
 ('61000000-0000-0000-0000-000000000001','authenticated','authenticated','owner-a@example.test','{}','{}'),
 ('61000000-0000-0000-0000-000000000002','authenticated','authenticated','teacher-a@example.test','{}','{}'),
 ('61000000-0000-0000-0000-000000000003','authenticated','authenticated','student-a@example.test','{}','{}'),
 ('61000000-0000-0000-0000-000000000004','authenticated','authenticated','operator@example.test','{}','{}'),
 ('61000000-0000-0000-0000-000000000005','authenticated','authenticated','owner-b@example.test','{}','{}'),
 ('61000000-0000-0000-0000-000000000006','authenticated','authenticated','admin-a@example.test','{}','{}');
insert into public.organizations (id, slug, name) values
 ('62000000-0000-0000-0000-000000000001','phase2-a','Phase 2 A'),
 ('62000000-0000-0000-0000-000000000002','phase2-b','Phase 2 B');
insert into public.organization_memberships (organization_id,user_id,role) values
 ('62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001','owner'),
 ('62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000002','teacher'),
 ('62000000-0000-0000-0000-000000000002','61000000-0000-0000-0000-000000000005','owner');
insert into public.platform_administrators (user_id) values ('61000000-0000-0000-0000-000000000004');
insert into public.classes (id,organization_id,teacher_id,name,join_code) values
 ('63000000-0000-0000-0000-000000000001','62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001','Class A','EEE-234');
insert into public.class_members (class_id,user_id,role,status) values
 ('63000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000003','student','active');
insert into public.sessions (id,student_id,class_id,started_at,ended_at) values
 ('64000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000003',
  '63000000-0000-0000-0000-000000000001',now(),now());

set local role authenticated;
select set_config('request.jwt.claim.sub','61000000-0000-0000-0000-000000000001',true);
select is(public.organization_has_entitlement('62000000-0000-0000-0000-000000000001','organization_admin'),true,'new organization has admin entitlement');
select is(public.resolve_existing_user('62000000-0000-0000-0000-000000000001','teacher-a@example.test'),
  '61000000-0000-0000-0000-000000000002'::uuid,'owner can resolve existing account by exact email');
select is(public.is_platform_administrator(),false,'owner is not platform administrator');
select results_eq($$ select count(*) from public.organizations $$,$$ values (1::bigint) $$,'owner sees own organization only');
select results_eq($$ select count(*) from public.platform_administrators $$,$$ values (0::bigint) $$,'owner cannot see platform roster');
do $$ begin
 begin
  perform public.set_organization_entitlement('62000000-0000-0000-0000-000000000001','budget_controls',true);
  raise exception 'owner self-granted entitlement';
 exception when insufficient_privilege then null; end;
end $$;
select pass('organization cannot self-grant entitlement');
do $$ begin
 begin
  insert into public.organization_entitlements (organization_id,capability,enabled)
    values ('62000000-0000-0000-0000-000000000001','budget_controls',true);
  raise exception 'direct entitlement write succeeded';
 exception when insufficient_privilege then null; end;
end $$;
select pass('organization cannot write entitlement table');
do $$ begin
 begin
  perform public.platform_update_organization('62000000-0000-0000-0000-000000000001','Wrong','suspended');
  raise exception 'tenant admin changed platform status';
 exception when insufficient_privilege then null; end;
end $$;
select pass('organization admin cannot change platform status');
do $$ begin
 begin
  perform public.assign_organization_teacher('62000000-0000-0000-0000-000000000002',
    '63000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000002',true);
  raise exception 'cross-tenant teacher assignment succeeded';
 exception when insufficient_privilege then null; end;
end $$;
select pass('owner cannot assign teacher across organizations');
select lives_ok($$ select public.assign_organization_teacher('62000000-0000-0000-0000-000000000001',
 '63000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000002',true) $$,'owner associates organization teacher');
select results_eq($$ select count(*) from public.class_members where class_id='63000000-0000-0000-0000-000000000001' and user_id='61000000-0000-0000-0000-000000000002' and role='teacher' $$,$$ values (1::bigint) $$,'teacher assignment exists');
select results_eq($$ select count(*) from public.administrative_audit_events where organization_id='62000000-0000-0000-0000-000000000001' and action='class.teacher_associated' and target_id='61000000-0000-0000-0000-000000000002' $$,$$ values (1::bigint) $$,'teacher association audited');
select results_eq($$ select count(*) from public.administrative_audit_events where organization_id='62000000-0000-0000-0000-000000000001' and action='class.created' $$,$$ values (1::bigint) $$,'class creation audited');
do $$ begin
 begin
  perform public.remove_organization_membership('62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001');
  raise exception 'final owner removed';
 exception when check_violation then null; end;
end $$;
select pass('final owner is protected');

select set_config('request.jwt.claim.sub','61000000-0000-0000-0000-000000000002',true);
select is(private.can_administer_organization('62000000-0000-0000-0000-000000000001'),false,'teacher role does not grant org admin');
select is(public.is_platform_administrator(),false,'teacher role does not grant platform admin');
select set_config('request.jwt.claim.sub','61000000-0000-0000-0000-000000000003',true);
select results_eq($$ select count(*) from public.organizations $$,$$ values (0::bigint) $$,'student cannot enter org administration');
select results_eq($$ select count(*) from public.administrative_audit_events $$,$$ values (0::bigint) $$,'student cannot read admin audit');
do $$ begin
 begin
  perform public.resolve_existing_user('62000000-0000-0000-0000-000000000001','teacher-a@example.test');
  raise exception 'student resolved account';
 exception when insufficient_privilege then null; end;
end $$;
select pass('student cannot resolve user accounts');
do $$ begin
 begin
  perform public.platform_organization_summary();
  raise exception 'student read platform summary';
 exception when insufficient_privilege then null; end;
end $$;
select pass('student cannot call platform summary');

select set_config('request.jwt.claim.sub','61000000-0000-0000-0000-000000000004',true);
select is(public.is_platform_administrator(),true,'operator has separate platform role');
select is(public.resolve_existing_user(null,'admin-a@example.test'),
  '61000000-0000-0000-0000-000000000006'::uuid,'operator can resolve an existing account');
select results_eq($$ select count(*) from public.organizations $$,$$ values (2::bigint) $$,'operator sees all organizations');
select results_eq($$ select count(*) from public.sessions $$,$$ values (0::bigint) $$,'operator has no invisible student session access');
select results_eq($$ select count(*) from public.classes $$,$$ values (0::bigint) $$,'operator role alone grants no class read');
select results_eq($$ select count(*) from public.platform_organization_summary() $$,$$ values (2::bigint) $$,'operator sees aggregate organization summary');
do $$ begin
 begin
  perform public.platform_set_organization_admin('62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000004',true);
  raise exception 'operator appointed self to tenant';
 exception when insufficient_privilege then null; end;
end $$;
select pass('platform operator cannot appoint itself tenant admin');
do $$ begin
 begin
  perform public.platform_create_organization('phase2-self','Self owned','61000000-0000-0000-0000-000000000004');
  raise exception 'operator created self-owned tenant';
 exception when insufficient_privilege then null; end;
end $$;
select pass('platform operator cannot make itself tenant owner');
select lives_ok($$ select public.set_organization_entitlement('62000000-0000-0000-0000-000000000001','organization_admin',false) $$,'operator can disable entitlement');
select results_eq($$ select count(*) from public.administrative_audit_events where action='entitlement.disabled' and actor_user_id='61000000-0000-0000-0000-000000000004' $$,$$ values (1::bigint) $$,'entitlement change audited with actor');

select set_config('request.jwt.claim.sub','61000000-0000-0000-0000-000000000001',true);
select is(private.can_administer_organization('62000000-0000-0000-0000-000000000001'),false,'disabling entitlement removes org admin access');
do $$ begin
 begin
  perform public.set_organization_membership('62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000006','admin');
  raise exception 'membership mutation succeeded after entitlement disabled';
 exception when insufficient_privilege then null; end;
end $$;
select pass('disabled entitlement blocks membership mutation');
select results_eq($$ select count(*) from public.administrative_audit_events where organization_id='62000000-0000-0000-0000-000000000001' $$,$$ values (0::bigint) $$,'disabled admin cannot read audit');

select set_config('request.jwt.claim.sub','61000000-0000-0000-0000-000000000004',true);
select lives_ok($$ select public.set_organization_entitlement('62000000-0000-0000-0000-000000000001','organization_admin',true) $$,'operator can restore entitlement');
select lives_ok($$ select public.platform_set_organization_admin('62000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000006',true) $$,'operator can appoint administrator');
select results_eq($$ select count(*) from public.administrative_audit_events where action='membership.added' and target_id='61000000-0000-0000-0000-000000000006' $$,$$ values (1::bigint) $$,'platform administrator appointment audited');
select lives_ok($$ select public.platform_create_organization('phase2-c','Phase 2 C','61000000-0000-0000-0000-000000000006') $$,'operator creates organization with owner');
select results_eq($$ select count(*) from public.administrative_audit_events where action='organization.created' and actor_user_id='61000000-0000-0000-0000-000000000004' $$,$$ values (1::bigint) $$,'operator organization creation audited');

select * from finish();
rollback;
