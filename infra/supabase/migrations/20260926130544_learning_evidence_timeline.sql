-- Rebuildable projection of local workspace events. The authoritative event
-- journal remains local; this table contains only bounded educational facts.
create table public.learning_evidence (
  id text primary key check (id ~ '^[a-f0-9]{64}$'),
  session_id uuid not null references public.sessions(id) on delete cascade,
  student_id uuid not null references public.profiles(id),
  class_id uuid not null references public.classes(id),
  project_id uuid not null references public.projects(id) on delete cascade,
  occurred_at timestamptz not null,
  category text not null check (category in (
    'plan_approved','student_edit','agent_edit','autocomplete_edit','student_revised_agent_work',
    'test_failed','fix_attempted','test_passed','fix_verified','learn_mode_used','question_completed','reflection_completed')),
  actor text not null check (actor in ('student','agent','mixed')),
  source text not null check (source in ('observed','deterministic','classified')),
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  summary text not null check (char_length(summary) between 1 and 160),
  check (summary !~* '(secret|credential|token|private.?key|sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,})'),
  source_event_ids text[] not null check (cardinality(source_event_ids) between 1 and 12
    and array_to_string(source_event_ids, ',') ~ '^([0-9a-f-]{36}:[0-9]{1,10}|session-reflection:[0-9a-f-]{36})(,([0-9a-f-]{36}:[0-9]{1,10}|session-reflection:[0-9a-f-]{36}))*$'),
  check ((source = 'classified') = (confidence is not null)),
  check (
    (category in ('student_edit','question_completed','learn_mode_used','reflection_completed') and actor = 'student' and source = 'observed') or
    (category = 'agent_edit' and actor = 'agent' and source = 'observed') or
    (category = 'autocomplete_edit' and actor = 'mixed' and source = 'observed') or
    (category in ('test_failed','test_passed') and actor in ('student','agent') and source = 'observed') or
    (category in ('plan_approved','student_revised_agent_work','fix_attempted') and actor = 'student' and source = 'deterministic') or
    (category = 'fix_verified' and actor in ('student','mixed') and source = 'deterministic')
  ),
  check (
    (category = 'plan_approved' and summary = 'Student plan approved') or
    (category = 'student_edit' and summary ~ '^Student edited [A-Za-z0-9][A-Za-z0-9._-]{0,79}$') or
    (category = 'agent_edit' and summary ~ '^Agent edited [A-Za-z0-9][A-Za-z0-9._-]{0,79}$') or
    (category = 'autocomplete_edit' and summary ~ '^Student accepted AI completion in [A-Za-z0-9][A-Za-z0-9._-]{0,79}$') or
    (category = 'student_revised_agent_work' and summary ~ '^Student revised agent work in [A-Za-z0-9][A-Za-z0-9._-]{0,79}$') or
    (category = 'test_failed' and summary = 'Test failed') or
    (category = 'fix_attempted' and summary = 'Student edited after a failed test') or
    (category = 'test_passed' and summary = 'Tests passed') or
    (category = 'fix_verified' and summary = 'Tests passed after student''s edit') or
    (category = 'learn_mode_used' and summary = 'Used Learn Mode for an AI turn') or
    (category = 'question_completed' and summary = 'Completed /question practice') or
    (category = 'reflection_completed' and summary = 'Student confirmed a reflection')
  )
);
create index learning_evidence_teacher_timeline_idx on public.learning_evidence(class_id, project_id, student_id, occurred_at desc);
create index learning_evidence_session_idx on public.learning_evidence(session_id, occurred_at);
alter table public.learning_evidence enable row level security;

create policy learning_evidence_select on public.learning_evidence for select to authenticated using (
  student_id = (select auth.uid()) or private.teacher_can_read_student(class_id, student_id)
);
create policy learning_evidence_insert on public.learning_evidence for insert to authenticated with check (
  student_id = (select auth.uid()) and private.is_active_class_member(class_id)
  and exists (select 1 from public.sessions s where s.id = session_id and s.student_id = student_id
    and s.class_id = class_id and s.project_id = project_id and occurred_at between s.started_at and s.ended_at)
);
create policy learning_evidence_delete on public.learning_evidence for delete to authenticated using (
  student_id = (select auth.uid())
);

revoke all on public.learning_evidence from public, anon;
grant select, insert, delete on public.learning_evidence to authenticated;

create or replace function public.replace_session_learning_evidence(session_id_input uuid, evidence_input jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  owner_session public.sessions%rowtype;
  item jsonb;
  inserted_count integer := 0;
begin
  if jsonb_typeof(evidence_input) is distinct from 'array' or jsonb_array_length(evidence_input) > 200 then
    raise exception 'Invalid evidence batch' using errcode = '22023';
  end if;
  select * into owner_session from public.sessions
    where id = session_id_input and student_id = (select auth.uid()) and project_id is not null;
  if not found then raise exception 'Student session required' using errcode = '42501'; end if;
  delete from public.learning_evidence where session_id = session_id_input;
  for item in select value from jsonb_array_elements(evidence_input) loop
    insert into public.learning_evidence(id,session_id,student_id,class_id,project_id,occurred_at,category,actor,source,confidence,summary,source_event_ids)
    values (
      item->>'id', owner_session.id, owner_session.student_id, owner_session.class_id, owner_session.project_id,
      (item->>'timestamp')::timestamptz, item->>'category', item->>'actor', item->>'source',
      (item->>'confidence')::real, item->>'summary',
      array(select jsonb_array_elements_text(item->'references'))
    );
    inserted_count := inserted_count + 1;
  end loop;
  return inserted_count;
end
$$;
revoke all on function public.replace_session_learning_evidence(uuid,jsonb) from public, anon;
grant execute on function public.replace_session_learning_evidence(uuid,jsonb) to authenticated;
