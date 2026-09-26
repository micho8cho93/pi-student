-- Teacher-owned, explainable queue. Rows refer to one session, so evidence and
-- teacher actions cannot drift across projects or classrooms.
create table public.intervention_items (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  student_id uuid not null references public.profiles(id),
  session_id uuid not null references public.sessions(id) on delete cascade,
  category text not null check (category in ('repeated_failures','agent_edit_balance','missing_reflection','ready_for_review')),
  priority text not null check (priority in ('high','medium','low')),
  explanation text not null check (explanation in (
    'At least three recorded test failures since the last recorded pass in this session.',
    'At least three agent edit groups make up 75% or more of recorded edit groups in this session.',
    'A session with a recorded test pass has no confirmed reflection after 24 hours.',
    'This session has a recorded test pass and confirmed reflection, with no later recorded failure.'
  )),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  status text not null default 'open' check (status in ('open','dismissed','resolved')),
  teacher_note text not null default '' check (char_length(teacher_note) <= 2000),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (session_id, category),
  check ((status = 'open') = (resolved_at is null))
);
create index intervention_items_queue_idx on public.intervention_items(class_id,status,priority,created_at desc);
alter table public.intervention_items enable row level security;
revoke all on public.intervention_items from public, anon, authenticated;
grant select on public.intervention_items to authenticated;
grant update (status,teacher_note) on public.intervention_items to authenticated;
create policy intervention_items_teacher_select on public.intervention_items for select to authenticated
  using (private.teacher_can_read_student(class_id,student_id));
create policy intervention_items_teacher_update on public.intervention_items for update to authenticated
  using (private.teacher_can_read_student(class_id,student_id))
  with check (private.teacher_can_read_student(class_id,student_id));

create function private.set_intervention_resolution_time()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'open' then
    new.resolved_at := null;
  elsif old.status = 'open' or new.resolved_at is null then
    new.resolved_at := now();
  end if;
  return new;
end $$;
revoke all on function private.set_intervention_resolution_time() from public, anon, authenticated;
create trigger set_intervention_resolution_time before update on public.intervention_items
  for each row execute function private.set_intervention_resolution_time();

-- Recompute only from bounded, metadata-only evidence. Teacher access is
-- checked before the definer reads any class records. No model inference enters
-- this priority calculation, and token usage is deliberately absent.
create function public.refresh_teacher_interventions(class_id_input uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  s record;
  generated integer := 0;
  failure_count integer;
  agent_count integer;
  student_count integer;
  revision_count integer;
  last_pass timestamptz;
  later_failure boolean;
  has_reflection boolean;
  reflection_required boolean;
begin
  if not private.is_class_teacher(class_id_input) then
    raise exception 'Teacher access required' using errcode = '42501';
  end if;
  update public.intervention_items set status = 'resolved'
    where class_id = class_id_input and status = 'open'
      and (created_at < now() - interval '30 days' or not exists (
        select 1 from public.sessions expired where expired.id = session_id
          and expired.started_at >= now() - interval '30 days'));
  for s in
    select sess.id, sess.student_id, sess.project_id, sess.ended_at,
      coalesce((sess.effective_policy->'settings'->>'reflection')::boolean,
        (p.capability_policy->>'reflection')::boolean, true) as reflection_required
    from public.sessions sess
    join public.projects p on p.id = sess.project_id and p.class_id = sess.class_id
    join public.class_members m on m.class_id = sess.class_id and m.user_id = sess.student_id
      and m.role = 'student' and m.status = 'active'
    where sess.class_id = class_id_input and sess.started_at >= now() - interval '30 days'
  loop
    select max(e.occurred_at) filter (where e.category = 'test_passed'),
      count(*) filter (where e.category = 'agent_edit'),
      count(*) filter (where e.category = 'student_edit'),
      count(*) filter (where e.category = 'student_revised_agent_work')
    into last_pass, agent_count, student_count, revision_count
    from public.learning_evidence e where e.session_id = s.id and e.project_id = s.project_id;
    select count(*), coalesce(bool_or(e.occurred_at > last_pass), false)
      into failure_count, later_failure
      from public.learning_evidence e
      where e.session_id = s.id and e.project_id = s.project_id
        and e.category = 'test_failed' and (last_pass is null or e.occurred_at > last_pass);
    select exists(select 1 from public.session_reflections r where r.session_id = s.id and r.student_id = s.student_id and r.confirmed_at is not null)
      into has_reflection;
    reflection_required := s.reflection_required;

    if failure_count >= 3 then
      insert into public.intervention_items(class_id,project_id,student_id,session_id,category,priority,explanation,evidence)
      values(class_id_input,s.project_id,s.student_id,s.id,'repeated_failures',
        case when failure_count >= 5 then 'high' else 'medium' end,
        'At least three recorded test failures since the last recorded pass in this session.',
        jsonb_build_object('failuresSincePass',failure_count,'lastPassAt',last_pass))
      on conflict (session_id,category) do update set priority = excluded.priority,
        explanation = excluded.explanation,evidence = excluded.evidence
      where public.intervention_items.status = 'open';
      generated := generated + 1;
    else
      update public.intervention_items set status = 'resolved'
        where session_id = s.id and category = 'repeated_failures' and status = 'open';
    end if;
    if agent_count >= 3 and agent_count * 4 >= (agent_count + student_count) * 3 and revision_count = 0 then
      insert into public.intervention_items(class_id,project_id,student_id,session_id,category,priority,explanation,evidence)
      values(class_id_input,s.project_id,s.student_id,s.id,'agent_edit_balance','medium',
        'At least three agent edit groups make up 75% or more of recorded edit groups in this session.',
        jsonb_build_object('agentEditGroups',agent_count,'studentEditGroups',student_count,'studentRevisions',revision_count))
      on conflict (session_id,category) do update set evidence = excluded.evidence
      where public.intervention_items.status = 'open';
      generated := generated + 1;
    else
      update public.intervention_items set status = 'resolved'
        where session_id = s.id and category = 'agent_edit_balance' and status = 'open';
    end if;
    if last_pass is not null and reflection_required and not has_reflection and s.ended_at < now() - interval '24 hours' then
      insert into public.intervention_items(class_id,project_id,student_id,session_id,category,priority,explanation,evidence)
      values(class_id_input,s.project_id,s.student_id,s.id,'missing_reflection','low',
        'A session with a recorded test pass has no confirmed reflection after 24 hours.',
        jsonb_build_object('lastPassAt',last_pass,'sessionEndedAt',s.ended_at))
      on conflict (session_id,category) do update set evidence = excluded.evidence
      where public.intervention_items.status = 'open';
      generated := generated + 1;
    else
      update public.intervention_items set status = 'resolved'
        where session_id = s.id and category = 'missing_reflection' and status = 'open';
    end if;
    if last_pass is not null and has_reflection and not later_failure then
      insert into public.intervention_items(class_id,project_id,student_id,session_id,category,priority,explanation,evidence)
      values(class_id_input,s.project_id,s.student_id,s.id,'ready_for_review','low',
        'This session has a recorded test pass and confirmed reflection, with no later recorded failure.',
        jsonb_build_object('lastPassAt',last_pass,'reflectionConfirmed',true))
      on conflict (session_id,category) do update set evidence = excluded.evidence
      where public.intervention_items.status = 'open';
      generated := generated + 1;
    else
      update public.intervention_items set status = 'resolved'
        where session_id = s.id and category = 'ready_for_review' and status = 'open';
    end if;
  end loop;
  return generated;
end $$;
revoke all on function public.refresh_teacher_interventions(uuid) from public, anon;
grant execute on function public.refresh_teacher_interventions(uuid) to authenticated;
