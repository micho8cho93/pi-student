-- The insert policy compared the session's columns with bare names inside its subquery. `sessions` has
-- student_id, class_id and project_id too, so each bare name bound to the session row instead of the row
-- being inserted (s.class_id = s.class_id), and the checks were always true. A student could attach evidence
-- to another project or class. Qualify the new row's columns so they are compared with the session.
drop policy learning_evidence_insert on public.learning_evidence;

create policy learning_evidence_insert on public.learning_evidence for insert to authenticated with check (
  learning_evidence.student_id = (select auth.uid()) and private.is_active_class_member(learning_evidence.class_id)
  and exists (select 1 from public.sessions s where s.id = learning_evidence.session_id and s.student_id = learning_evidence.student_id
    and s.class_id = learning_evidence.class_id and s.project_id = learning_evidence.project_id
    and learning_evidence.occurred_at between s.started_at and s.ended_at)
);
