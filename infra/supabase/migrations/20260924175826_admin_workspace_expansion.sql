create or replace function private.require_live_account()
returns trigger language plpgsql security definer set search_path = '' as $$
declare target_user uuid;
begin
  if tg_table_name = 'classes' then target_user := new.teacher_id; else target_user := new.user_id; end if;
  -- Account closure locks the Auth row first, so a concurrent class or
  -- membership insert waits and sees the committed deleted marker.
  perform 1 from auth.users u where u.id = target_user for share;
  if exists (select 1 from public.profiles p where p.id = target_user and p.account_deleted_at is not null) then
    raise exception 'This account has been deleted' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Shared class workspace: retain the real administrator identity.
create or replace function private.teacher_workspace_access(class_id_input uuid)
returns boolean language sql stable security definer set search_path = '' as $$
 select private.can_manage_class(class_id_input) and private.class_workspace_active(class_id_input)
 and exists(select 1 from public.profiles where id=auth.uid() and account_deleted_at is null)
$$;

create function public.remove_class_student(class_id_input uuid,user_id_input uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
 if not private.teacher_workspace_access(class_id_input) then raise exception 'Class management required' using errcode='42501'; end if;
 -- Rejected membership preserves history and requires fresh approval on rejoin.
 update public.class_members set status='rejected' where class_id=class_id_input and user_id=user_id_input and role='student' and status='active';
 if not found then raise exception 'Active student not found'; end if;
 insert into public.administrative_audit_events(actor_user_id,organization_id,action,target_type,target_id,details)
 select auth.uid(),organization_id,'class.student_removed','class',id::text,jsonb_build_object('studentId',user_id_input) from public.classes where id=class_id_input;
end $$;

create function public.class_capability_context(class_id_input uuid, project_id_input uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid; settings jsonb; layer record; paths text[];
begin
 if not private.teacher_workspace_access(class_id_input) then raise exception 'Class management required' using errcode='42501'; end if;
 select organization_id into org from public.classes where id=class_id_input;
 if project_id_input is not null and not exists(select 1 from public.projects where id=project_id_input and class_id=class_id_input) then raise exception 'Project outside class'; end if;
 settings := '{"schemaVersion":1,"reasoningLevels":["off","minimal","low","medium","high","xhigh","max"],"models":[],"fileEditing":true,"terminal":true,"dependencyInstallation":true,"internet":true,"desktopExport":true,"imageUploads":true,"fileUploads":true,"reflection":true,"limits":{"minutes":null,"turns":null,"tokens":null,"cost":null},"accessibility":{"dictation":true,"cloudDictation":true,"readAloud":false,"simplifiedVocabulary":false,"readableFormatting":false}}'::jsonb;
 if project_id_input is not null then select capability_policy into settings from public.projects where id=project_id_input; end if;
 select delegated_paths into paths from public.governance_policies where organization_id=org and scope='organization';
 for layer in select g.settings from public.governance_policies g where g.organization_id=org and (g.scope='organization' or (g.scope='class' and g.class_id=class_id_input) or (g.scope='project' and g.project_id=project_id_input)) order by case g.scope when 'organization' then 1 when 'class' then 2 else 3 end loop
 settings := (settings || layer.settings) || jsonb_build_object('limits',settings->'limits'||coalesce(layer.settings->'limits','{}'::jsonb),'accessibility',settings->'accessibility'||coalesce(layer.settings->'accessibility','{}'::jsonb));
 end loop;
 return jsonb_build_object('settings',settings,'delegatedPaths',coalesce(paths,'{}'::text[]),'models',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'name',m.display_name) order by m.display_name) from public.model_profiles m where m.organization_id=org and m.available),'[]'::jsonb));
end $$;

create function public.create_class_project(class_id_input uuid,name_input text,description_input text,brief_input jsonb,capabilities_input jsonb)
returns table(id uuid) language plpgsql security definer set search_path = '' as $$
declare created uuid; org uuid;
begin
 if not private.teacher_workspace_access(class_id_input) then raise exception 'Class management required' using errcode='42501'; end if;
 select organization_id into org from public.classes where classes.id=class_id_input;
 if org is null then
 insert into public.projects(class_id,name,description,brief,capability_policy) values(class_id_input,name_input,description_input,brief_input,capabilities_input) returning projects.id into created;
 else
 insert into public.projects(class_id,name,description,brief) values(class_id_input,name_input,description_input,brief_input) returning projects.id into created;
 if capabilities_input <> '{}'::jsonb then perform public.save_governance_policy(org,'project',class_id_input,created,capabilities_input,'{}'); end if;
 end if;
 return query select created;
end $$;

create function public.platform_users(search_input text default '',offset_input integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
 if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode='42501'; end if;
 return jsonb_build_object('total',(select count(*) from public.profiles p where concat(p.display_name,' ',p.email) ilike '%'||search_input||'%'),
 'users',coalesce((select jsonb_agg(row) from (select p.id,p.display_name,coalesce(p.email,case when u.deleted_at is null then u.email end) as email,p.created_at,p.account_deleted_at,
 (p.account_deleted_at is not null and u.deleted_at is null) as deletion_pending,
 (select coalesce(jsonb_agg(jsonb_build_object('name',o.name,'role',m.role,'status',m.status)),'[]'::jsonb) from public.organization_memberships m join public.organizations o on o.id=m.organization_id where m.user_id=p.id) organizations,
 (select count(*) from public.class_members cm where cm.user_id=p.id and cm.status='active') classes,
 exists(select 1 from public.platform_administrators a where a.user_id=p.id) platform_admin
 from public.profiles p join auth.users u on u.id=p.id where concat(p.display_name,' ',p.email) ilike '%'||search_input||'%' order by p.created_at desc,p.id limit 50 offset greatest(offset_input,0)) row),'[]'::jsonb));
end $$;

create function public.platform_analytics(days_input integer default 30,organization_id_input uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := now()-make_interval(days=>least(greatest(days_input,1),365)); result jsonb;
begin
 if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode='42501'; end if;
 with scoped as (select s.* from public.sessions s join public.classes c on c.id=s.class_id where s.started_at>=since and (organization_id_input is null or c.organization_id=organization_id_input)),
 daily as(select date_trunc('day',started_at)::date as day,count(*) sessions,count(distinct student_id) active_users,sum(total_tokens) tokens,round(sum(duration_seconds)/60.0) minutes from scoped group by 1),
 models as(select array_to_string(models, ', ') model,count(*) sessions,sum(total_tokens) tokens from scoped group by models)
 select jsonb_build_object('sessions',(select count(*) from scoped),'activeUsers',(select count(distinct student_id) from scoped),
 'users',(select count(*) from public.profiles p where p.account_deleted_at is null and (organization_id_input is null or exists(select 1 from public.class_members cm join public.classes c on c.id=cm.class_id where cm.user_id=p.id and c.organization_id=organization_id_input))),
 'classes',(select count(*) from public.classes where organization_id_input is null or organization_id=organization_id_input),
 'projects',(select count(*) from public.projects p join public.classes c on c.id=p.class_id where organization_id_input is null or c.organization_id=organization_id_input),
 'daily',coalesce((select jsonb_agg(d order by day) from daily d),'[]'::jsonb),'models',coalesce((select jsonb_agg(m order by tokens desc) from models m),'[]'::jsonb),
 'cost',coalesce((select sum(known_cost_micros) from public.usage_daily where usage_day>=since::date and (organization_id_input is null or organization_id=organization_id_input)),0),
 'unpriced',coalesce((select sum(unknown_cost_count) from public.usage_daily where usage_day>=since::date and (organization_id_input is null or organization_id=organization_id_input)),0)) into result;
 return result;
end $$;

create table public.security_alerts (
 id uuid primary key default gen_random_uuid(),dedupe_key text not null unique,
 user_id uuid references public.profiles(id),class_id uuid references public.classes(id),
 category text not null check(category in ('email_domain','failed_login','chat_safety')),
 severity text not null check(severity in ('low','medium','high')),
 summary text not null check(length(summary)<=500),source text not null,
 occurred_at timestamptz not null default now(),status text not null default 'open' check(status in ('open','resolved','dismissed')),
 reviewed_by uuid references public.profiles(id),reviewed_at timestamptz
);
alter table public.security_alerts enable row level security;
revoke all on public.security_alerts from public,anon,authenticated;
grant select on public.security_alerts to authenticated;
create policy platform_security_read on public.security_alerts for select to authenticated using(private.is_platform_administrator());
create index security_alerts_queue on public.security_alerts(status,occurred_at desc);
create table public.school_email_domains (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 domain text not null check(domain=lower(domain) and domain ~ '^[a-z0-9][a-z0-9.-]*[.][a-z]{2,}$'),
 primary key(organization_id,domain)
);
alter table public.school_email_domains enable row level security;
revoke all on public.school_email_domains from public,anon,authenticated;
grant select,insert,delete on public.school_email_domains to authenticated;
create policy domain_admin on public.school_email_domains for all to authenticated using(private.can_administer_organization(organization_id) or private.is_platform_administrator()) with check(private.can_administer_organization(organization_id) or private.is_platform_administrator());

create function public.refresh_platform_security()
returns void language plpgsql security definer set search_path = '' as $$
begin
 if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode='42501'; end if;
 insert into public.security_alerts(dedupe_key,user_id,class_id,category,severity,summary,source)
 select 'domain:'||cm.id||':'||lower(split_part(p.email,'@',2)),p.id,c.id,'email_domain','low','Student email domain differs from the class teachers and approved school domains.','Class membership'
 from public.class_members cm join public.classes c on c.id=cm.class_id join public.profiles p on p.id=cm.user_id
 where cm.role='student' and cm.status='active' and p.email like '%@%'
 and exists(select 1 from public.class_members t join public.profiles tp on tp.id=t.user_id where t.class_id=c.id and t.role='teacher' and t.status='active' and tp.email like '%@%')
 and not exists(select 1 from public.class_members t join public.profiles tp on tp.id=t.user_id where t.class_id=c.id and t.role='teacher' and t.status='active' and lower(split_part(tp.email,'@',2))=lower(split_part(p.email,'@',2)))
 and not exists(select 1 from public.school_email_domains d where d.organization_id=c.organization_id and d.domain=lower(split_part(p.email,'@',2)))
 on conflict(dedupe_key) do nothing;
end $$;

create function public.review_security_alert(alert_id_input uuid,status_input text)
returns void language plpgsql security definer set search_path = '' as $$
begin
 if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode='42501'; end if;
 if status_input not in ('open','resolved','dismissed') then raise exception 'Invalid review status'; end if;
 update public.security_alerts set status=status_input,reviewed_by=auth.uid(),reviewed_at=now() where id=alert_id_input;
 insert into public.administrative_audit_events(actor_user_id,action,target_type,target_id,details) values(auth.uid(),'security.reviewed','security_alert',alert_id_input::text,jsonb_build_object('status',status_input));
end $$;

revoke all on function public.remove_class_student(uuid,uuid) from public,anon;
grant execute on function public.remove_class_student(uuid,uuid) to authenticated;

revoke all on function public.class_capability_context(uuid,uuid) from public,anon;
grant execute on function public.class_capability_context(uuid,uuid) to authenticated;

revoke all on function public.create_class_project(uuid,text,text,jsonb,jsonb) from public,anon;
grant execute on function public.create_class_project(uuid,text,text,jsonb,jsonb) to authenticated;

revoke all on function public.platform_users(text,integer) from public,anon;
grant execute on function public.platform_users(text,integer) to authenticated;

revoke all on function public.platform_analytics(integer,uuid) from public,anon;
grant execute on function public.platform_analytics(integer,uuid) to authenticated;

revoke all on function public.refresh_platform_security() from public,anon;
grant execute on function public.refresh_platform_security() to authenticated;

revoke all on function public.review_security_alert(uuid,text) from public,anon;
grant execute on function public.review_security_alert(uuid,text) to authenticated;

create function public.platform_sync_user_profile(user_id_input uuid,name_input text)
returns void language plpgsql security definer set search_path = '' as $$
begin
 if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode='42501'; end if;
 update public.profiles p set display_name=name_input,email=u.email,updated_at=now() from auth.users u where p.id=user_id_input and u.id=p.id and p.account_deleted_at is null;
 if not found then raise exception 'Active account not found'; end if;
 insert into public.administrative_audit_events(actor_user_id,action,target_type,target_id) values(auth.uid(),'user.profile_updated','user',user_id_input::text);
end $$;
create function public.platform_prepare_user_deletion(user_id_input uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
 if not private.is_platform_administrator() or user_id_input=auth.uid() then raise exception 'Another platform administrator is required' using errcode='42501'; end if;
 perform 1 from auth.users where id=user_id_input for update;
 -- Serialize final-administrator and final-owner protection.
 perform 1 from public.platform_administrators order by user_id for update;
 if exists(select 1 from public.platform_administrators where user_id=user_id_input) and (select count(*) from public.platform_administrators)<2 then raise exception 'Cannot delete the last platform administrator'; end if;
 perform 1 from public.organizations o join public.organization_memberships m on m.organization_id=o.id where m.user_id=user_id_input order by o.id for update of o;
 if exists(select 1 from public.organization_memberships m join public.organizations o on o.id=m.organization_id where m.user_id=user_id_input and m.role='owner' and m.status='active' and o.deactivated_at is null and not exists(select 1 from public.organization_memberships other where other.organization_id=m.organization_id and other.user_id<>user_id_input and other.role='owner' and other.status='active')) then raise exception 'Transfer organization ownership before deleting this account'; end if;
 delete from auth.sessions where user_id=user_id_input;
 delete from auth.refresh_tokens where user_id=user_id_input::text;
 update public.classes set join_enabled=false where teacher_id=user_id_input and organization_id is null;
 delete from public.class_members cm using public.classes c where cm.class_id=c.id and c.teacher_id=user_id_input and c.organization_id is null;
 delete from public.class_members where user_id=user_id_input;
 update public.profiles set display_name='Deleted user',email=null,account_deleted_at=now() where id=user_id_input;
 delete from public.organization_memberships where user_id=user_id_input;
 delete from public.teacher_preferences where user_id=user_id_input;
 delete from public.platform_administrators where user_id=user_id_input;
 insert into public.administrative_audit_events(actor_user_id,action,target_type,target_id) values(auth.uid(),'user.deleted','user',user_id_input::text);
end $$;
revoke all on function public.platform_sync_user_profile(uuid,text),public.platform_prepare_user_deletion(uuid) from public,anon;
grant execute on function public.platform_sync_user_profile(uuid,text),public.platform_prepare_user_deletion(uuid) to authenticated;

create function public.record_chat_safety_signal(class_id_input uuid,categories_input text[])
returns void language plpgsql security definer set search_path = '' as $$
declare category text;
begin
 if auth.uid() is null or not exists(select 1 from public.class_members where class_id=class_id_input and user_id=auth.uid() and role='student' and status='active') then raise exception 'Active student membership required' using errcode='42501'; end if;
 if categories_input is null or not categories_input <@ array['self_harm_intent','threat_of_violence']::text[] then raise exception 'Unknown safety category'; end if;
 foreach category in array categories_input loop
 insert into public.security_alerts(dedupe_key,user_id,class_id,category,severity,summary,source)
 values('chat:'||auth.uid()||':'||class_id_input||':'||category||':'||date_trunc('hour',now()),auth.uid(),class_id_input,'chat_safety','high',category,'Student runtime: literal phrase signal; review context') on conflict(dedupe_key) do nothing;
 end loop;
end $$;
revoke all on function public.record_chat_safety_signal(uuid,text[]) from public,anon;
grant execute on function public.record_chat_safety_signal(uuid,text[]) to authenticated;

-- Trusted ingestion accepts only aggregate failure metadata, never credentials.
create function public.ingest_auth_failure_alert(email_input text,event_key_input text,count_input integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
 if count_input<5 or count_input>100000 or length(event_key_input)>200 then raise exception 'Invalid aggregate'; end if;
 insert into public.security_alerts(dedupe_key,user_id,category,severity,summary,source)
 values('auth:'||event_key_input,(select id from public.profiles where lower(email)=lower(email_input) limit 1),'failed_login','medium',count_input||' failed authentication attempts in a 15-minute window.','Supabase Auth logs') on conflict(dedupe_key) do nothing;
end $$;
revoke all on function public.ingest_auth_failure_alert(text,text,integer) from public,anon,authenticated;
grant execute on function public.ingest_auth_failure_alert(text,text,integer) to service_role;

create function public.platform_security_alerts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
 if not private.is_platform_administrator() then raise exception 'Platform administration required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(row) from (select a.*,jsonb_build_object('display_name',p.display_name,'email',p.email) profiles,jsonb_build_object('name',c.name) classes from public.security_alerts a left join public.profiles p on p.id=a.user_id left join public.classes c on c.id=a.class_id order by a.occurred_at desc limit 200) row),'[]'::jsonb);
end $$;
revoke all on function public.platform_security_alerts() from public,anon;
grant execute on function public.platform_security_alerts() to authenticated;
create or replace function public.governance_context(project_id_input uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare class_row record; result jsonb;
begin
  select p.id project_id,p.class_id,p.capability_policy,p.policy_version,c.organization_id into class_row
    from public.projects p join public.classes c on c.id=p.class_id where p.id=project_id_input;
  if class_row.organization_id is null or not (private.is_active_class_member(class_row.class_id) or private.teacher_workspace_access(class_row.class_id)) then
    raise exception 'Managed project access required' using errcode='42501'; end if;
  select jsonb_build_object('organizationId',class_row.organization_id,'classId',class_row.class_id,
    'project',jsonb_build_object('scope','project','version',class_row.policy_version,'settings',class_row.capability_policy),
    'layers',coalesce(jsonb_agg(jsonb_build_object('scope',g.scope,'version',g.version,'settings',g.settings,'delegatedPaths',g.delegated_paths)) filter (where g.id is not null),'[]'::jsonb))
    into result from public.governance_policies g where g.organization_id=class_row.organization_id
      and (g.scope='organization' or (g.scope='class' and g.class_id=class_row.class_id) or (g.scope='project' and g.project_id=project_id_input));
  return result;
end;
$$;
revoke all on function public.governance_context(uuid) from public, anon;
grant execute on function public.governance_context(uuid) to authenticated;
