-- Transactional integration checks: no fixture identities or sessions survive.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(1);
create temporary table policy_fixture as select gen_random_uuid() teacher, gen_random_uuid() other_teacher, gen_random_uuid() student, gen_random_uuid() class, gen_random_uuid() project, gen_random_uuid() session;
grant select on policy_fixture to authenticated;
insert into auth.users(id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
select teacher, 'authenticated', 'authenticated', teacher::text || '@example.test', '{}'::jsonb, '{}'::jsonb from policy_fixture
union all select other_teacher, 'authenticated', 'authenticated', other_teacher::text || '@example.test', '{}'::jsonb, '{}'::jsonb from policy_fixture
union all select student, 'authenticated', 'authenticated', student::text || '@example.test', '{}'::jsonb, '{}'::jsonb from policy_fixture;
insert into public.classes(id,teacher_id,name) select class,teacher,'Capability test' from policy_fixture;
insert into public.projects(id,class_id,name) select project,class,'Capability test' from policy_fixture;
insert into public.class_members(class_id,user_id,role,status) select class,student,'student','active' from policy_fixture;

set local role authenticated;
select set_config('request.jwt.claim.sub', (select teacher::text from policy_fixture), true);
do $$
declare v integer; p jsonb;
begin
  update public.projects set capability_policy=jsonb_set(capability_policy,'{reasoningLevels}','["low","high"]') where id=(select project from policy_fixture);
  select policy_version,capability_policy into v,p from public.projects where id=(select project from policy_fixture);
  if v <> 2 or p->'reasoningLevels' <> '["low","high"]' then raise exception 'Teacher settings/version did not update'; end if;
  update public.projects set name='Renamed',policy_version=999 where id=(select project from policy_fixture);
  if (select policy_version from public.projects where id=(select project from policy_fixture)) <> 2 then raise exception 'Unrelated edits changed policy version'; end if;
  begin
    update public.projects set capability_policy=jsonb_set(capability_policy,'{reasoningLevels}','[]') where id=(select project from policy_fixture);
    raise exception 'Empty reasoning levels were accepted';
  exception when check_violation then null; end;
end;
$$;
select set_config('request.jwt.claim.sub', (select other_teacher::text from policy_fixture), true);
do $$
declare n integer;
begin
 update public.projects set capability_policy=jsonb_set(capability_policy,'{terminal}','false') where id=(select project from policy_fixture);
 get diagnostics n = row_count;
 if n <> 0 then raise exception 'Another teacher changed project controls'; end if;
end;
$$;
select set_config('request.jwt.claim.sub', (select student::text from policy_fixture), true);
do $$
declare n integer;
begin
 update public.projects set capability_policy=jsonb_set(capability_policy,'{terminal}','false') where id=(select project from policy_fixture);
 get diagnostics n = row_count;
 if n <> 0 then raise exception 'Student changed project controls'; end if;
end;
$$;
insert into public.sessions(id,student_id,class_id,project_id,started_at,ended_at,effective_policy,policy_compliance)
select f.session,f.student,f.class,f.project,now(),now(),jsonb_build_object('projectId',f.project,'version',p.policy_version,'settings',p.capability_policy),' {"blockedActions":{"terminal":1}}'::jsonb
from policy_fixture f join public.projects p on p.id=f.project;
select set_config('request.jwt.claim.sub', (select teacher::text from policy_fixture), true);
update public.projects set capability_policy=jsonb_set(capability_policy,'{terminal}','false') where id=(select project from policy_fixture);
do $$
begin
 if (select effective_policy->>'version' from public.sessions where id=(select session from policy_fixture)) <> '2' then raise exception 'Historical policy changed'; end if;
 if (select effective_policy->'settings'->>'terminal' from public.sessions where id=(select session from policy_fixture)) <> 'true' then raise exception 'Historical settings changed'; end if;
end;
$$;
select set_config('request.jwt.claim.sub', (select student::text from policy_fixture), true);
do $$
begin
 begin
   update public.sessions set effective_policy=jsonb_set(effective_policy,'{version}','3') where id=(select session from policy_fixture);
   raise exception 'Policy snapshot was mutable';
 exception when raise_exception then
   if SQLERRM <> 'The effective policy and project of a recorded session cannot change' then raise; end if;
 end;
end;
$$;
reset role;
select pass('Project policy validation, ownership, versioning and immutable session history');
select * from finish();
rollback;
