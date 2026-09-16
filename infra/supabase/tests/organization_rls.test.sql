begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(31);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('51000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'org-a-owner@example.test', '{}', '{}'),
  ('51000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'org-a-admin@example.test', '{}', '{}'),
  ('51000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'org-a-teacher@example.test', '{}', '{}'),
  ('51000000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'org-a-member@example.test', '{}', '{}'),
  ('51000000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'org-a-student@example.test', '{}', '{}'),
  ('52000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'org-b-owner@example.test', '{}', '{}'),
  ('52000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'org-b-teacher@example.test', '{}', '{}'),
  ('52000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'org-b-student@example.test', '{}', '{}');

insert into public.organizations (id, slug, name) values
  ('53000000-0000-0000-0000-000000000001', 'org-a-test', 'Organization A'),
  ('53000000-0000-0000-0000-000000000002', 'org-b-test', 'Organization B');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'owner'),
  ('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000002', 'admin'),
  ('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000003', 'teacher'),
  ('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000004', 'member'),
  ('53000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000001', 'owner'),
  ('53000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000002', 'teacher');
insert into public.classes (id, teacher_id, organization_id, name, join_code) values
  ('54000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000003', '53000000-0000-0000-0000-000000000001', 'A class', 'AAA-234'),
  ('54000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000002', '53000000-0000-0000-0000-000000000002', 'B class', 'BBB-234'),
  ('54000000-0000-0000-0000-000000000003', '51000000-0000-0000-0000-000000000003', null, 'Legacy class', 'CCC-234'),
  ('54000000-0000-0000-0000-000000000004', '51000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001', 'Other A class', 'DDD-234');
insert into public.class_members (class_id, user_id, role, status) values
  ('54000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000005', 'student', 'active'),
  ('54000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000003', 'student', 'active');
insert into public.projects (id, class_id, name) values
  ('55000000-0000-0000-0000-000000000001', '54000000-0000-0000-0000-000000000001', 'A project'),
  ('55000000-0000-0000-0000-000000000002', '54000000-0000-0000-0000-000000000002', 'B project');
insert into public.sessions (id, student_id, class_id, project_id, started_at, ended_at) values
  ('56000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000005', '54000000-0000-0000-0000-000000000001', '55000000-0000-0000-0000-000000000001', now(), now()),
  ('56000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000003', '54000000-0000-0000-0000-000000000002', '55000000-0000-0000-0000-000000000002', now(), now());

set local role authenticated;
select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000002', true);
select results_eq($$ select count(*) from public.organizations $$, $$ values (1::bigint) $$, 'A admin sees only A organization');
select results_eq($$ select count(*) from public.organization_memberships where organization_id = '53000000-0000-0000-0000-000000000002' $$, $$ values (0::bigint) $$, 'A admin cannot read B memberships');
select results_eq($$ select count(*) from public.classes where organization_id = '53000000-0000-0000-0000-000000000002' $$, $$ values (0::bigint) $$, 'A admin cannot read B class');
select results_eq($$ select count(*) from public.projects where id = '55000000-0000-0000-0000-000000000002' $$, $$ values (0::bigint) $$, 'A admin cannot read B project');
select results_eq($$ with changed as (update public.organizations set name = 'Wrong' where id = '53000000-0000-0000-0000-000000000002' returning id) select count(*) from changed $$, $$ values (0::bigint) $$, 'A admin cannot update B organization');
select results_eq($$ with changed as (update public.classes set name = 'Wrong' where id = '54000000-0000-0000-0000-000000000002' returning id) select count(*) from changed $$, $$ values (0::bigint) $$, 'A admin cannot update B class');
select results_eq($$ with changed as (update public.projects set name = 'Wrong' where id = '55000000-0000-0000-0000-000000000002' returning id) select count(*) from changed $$, $$ values (0::bigint) $$, 'A admin cannot update B project');
select results_eq($$ with changed as (update public.projects set name = 'Admin edit' where id = '55000000-0000-0000-0000-000000000001' returning id) select count(*) from changed $$, $$ values (1::bigint) $$, 'A admin can manage A project');
select results_eq($$ select count(*) from public.sessions where id = '56000000-0000-0000-0000-000000000002' $$, $$ values (0::bigint) $$, 'A admin cannot read B student session');
select results_eq($$ select count(*) from public.sessions where id = '56000000-0000-0000-0000-000000000001' $$, $$ values (1::bigint) $$, 'A admin can read A class student session');
do $$ begin
  begin
    perform public.set_organization_membership('53000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000002', 'owner');
    raise exception 'A admin granted itself B membership';
  exception when insufficient_privilege then null; end;
end $$;
select pass('A admin cannot grant itself B organization membership');

select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000004', true);
select results_eq($$ select count(*) from public.classes where id = '54000000-0000-0000-0000-000000000001' $$, $$ values (0::bigint) $$, 'A organization membership does not grant class access');
select results_eq($$ select count(*) from public.projects where id = '55000000-0000-0000-0000-000000000001' $$, $$ values (0::bigint) $$, 'A organization membership does not grant project access');
do $$ begin
  begin
    perform public.set_organization_membership('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000004', 'admin');
    raise exception 'Member escalated own role';
  exception when insufficient_privilege then null; end;
end $$;
select pass('member cannot grant itself organization administration');
do $$ begin
  begin
    insert into public.organization_memberships (organization_id, user_id, role)
      values ('53000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000004', 'owner');
    raise exception 'Direct membership insert succeeded';
  exception when insufficient_privilege then null; end;
end $$;
select pass('client cannot insert organization membership directly');

select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000003', true);
select results_eq($$ select count(*) from public.classes where id = '54000000-0000-0000-0000-000000000001' $$, $$ values (1::bigint) $$, 'A teacher reads assigned managed class');
select results_eq($$ select count(*) from public.classes where id = '54000000-0000-0000-0000-000000000002' $$, $$ values (0::bigint) $$, 'A teacher cannot read B class');
select results_eq($$ select count(*) from public.classes where id = '54000000-0000-0000-0000-000000000004' $$, $$ values (0::bigint) $$, 'A teacher cannot read unrelated class in same organization');
select results_eq($$ select count(*) from public.classes where id = '54000000-0000-0000-0000-000000000003' $$, $$ values (1::bigint) $$, 'Existing standalone class remains accessible');
select results_eq($$ with changed as (update public.projects set name = 'Teacher edit' where id = '55000000-0000-0000-0000-000000000001' returning id) select count(*) from changed $$, $$ values (1::bigint) $$, 'A teacher can update assigned class project');
do $$ begin
  begin
    update public.classes set organization_id = '53000000-0000-0000-0000-000000000002'
      where id = '54000000-0000-0000-0000-000000000001';
    raise exception 'Class tenant was changed';
  exception when insufficient_privilege then null; end;
end $$;
select pass('client cannot move an existing class between organizations');
do $$ begin
  begin
    insert into public.classes (name, teacher_id, organization_id)
      values ('Forged B class', '51000000-0000-0000-0000-000000000003', '53000000-0000-0000-0000-000000000002');
    raise exception 'Client-supplied B organization was accepted';
  exception when insufficient_privilege then null; end;
end $$;
select pass('client-supplied organization ID cannot bypass membership');

select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000005', true);
select results_eq($$ select count(*) from public.projects where id = '55000000-0000-0000-0000-000000000001' $$, $$ values (1::bigint) $$, 'student reads own class project without org membership');
select results_eq($$ select count(*) from public.organizations $$, $$ values (0::bigint) $$, 'classroom student cannot read organization administration');
select results_eq($$ with changed as (update public.projects set name = 'Wrong' where id = '55000000-0000-0000-0000-000000000001' returning id) select count(*) from changed $$, $$ values (0::bigint) $$, 'student cannot modify project');

reset role;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  begin
    perform count(*) from public.organizations;
    raise exception 'Anonymous organization access was granted';
  exception when insufficient_privilege then null; end;
end $$;
select pass('unauthenticated caller has no tenant table access');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000001', true);
do $$ begin
  begin
    perform public.remove_organization_membership('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001');
    raise exception 'Last owner removal succeeded';
  exception when check_violation then null; end;
end $$;
select pass('final active owner cannot be removed');
select lives_ok($$ select public.remove_organization_membership('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000003') $$, 'owner can remove teacher organization membership');
select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000003', true);
select results_eq($$ select count(*) from public.classes where id = '54000000-0000-0000-0000-000000000001' $$, $$ values (0::bigint) $$, 'removed teacher loses managed class access immediately');

select set_config('request.jwt.claim.sub', '51000000-0000-0000-0000-000000000001', true);
select lives_ok($$ select public.set_organization_membership('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000004', 'admin') $$, 'owner can appoint a second administrator');
select results_eq($$ select count(*) from public.organization_memberships where organization_id = '53000000-0000-0000-0000-000000000001' and role = 'admin' $$, $$ values (2::bigint) $$, 'organization supports multiple administrators');

select * from finish();
rollback;
