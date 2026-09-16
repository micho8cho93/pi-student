create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create type public.class_role as enum ('teacher', 'student');
create type public.membership_status as enum ('pending', 'active', 'rejected');
create type public.assistance_level as enum ('none', 'low', 'moderate', 'high');

create or replace function private.generate_join_code()
returns text
language sql
volatile
set search_path = ''
as $$
  with random_value as (select extensions.gen_random_bytes(6) as bytes),
  alphabet as (select 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'::text as chars)
  select concat(
    substr(chars, get_byte(bytes, 0) % 32 + 1, 1),
    substr(chars, get_byte(bytes, 1) % 32 + 1, 1),
    substr(chars, get_byte(bytes, 2) % 32 + 1, 1), '-',
    substr(chars, get_byte(bytes, 3) % 32 + 1, 1),
    substr(chars, get_byte(bytes, 4) % 32 + 1, 1),
    substr(chars, get_byte(bytes, 5) % 32 + 1, 1)
  ) from random_value, alphabet;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid() references public.profiles(id),
  name text not null check (char_length(name) between 1 and 160),
  join_code text not null default private.generate_join_code() unique check (join_code ~ '^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$'),
  join_code_expires_at timestamptz,
  join_enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.class_members (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.class_role not null default 'student',
  joined_at timestamptz not null default now(),
  status public.membership_status not null default 'pending',
  unique (class_id, user_id)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 180),
  description text check (char_length(description) <= 2000),
  created_at timestamptz not null default now()
);

create table public.project_requirements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  description text check (char_length(description) <= 2000),
  position integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.standards (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classes(id) on delete cascade,
  code text not null check (char_length(code) between 1 and 80),
  title text not null check (char_length(title) between 1 and 300),
  description text check (char_length(description) <= 2000),
  created_at timestamptz not null default now(),
  unique (class_id, code)
);

create table public.project_standards (
  project_id uuid not null references public.projects(id) on delete cascade,
  standard_id uuid not null references public.standards(id) on delete cascade,
  primary key (project_id, standard_id)
);

create table public.sessions (
  id uuid primary key,
  student_id uuid not null references public.profiles(id),
  class_id uuid not null references public.classes(id),
  project_id uuid references public.projects(id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  goal text check (char_length(goal) <= 1000),
  providers text[] not null default '{}',
  models text[] not null default '{}',
  thinking_mode text check (char_length(thinking_mode) <= 40),
  agent_turn_count integer not null default 0 check (agent_turn_count >= 0),
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  total_tokens bigint not null default 0 check (total_tokens >= 0),
  files_created integer not null default 0 check (files_created >= 0),
  files_modified integer not null default 0 check (files_modified >= 0),
  files_deleted integer not null default 0 check (files_deleted >= 0),
  tests_run integer not null default 0 check (tests_run >= 0),
  planning_assistance public.assistance_level not null default 'none',
  implementation_assistance public.assistance_level not null default 'none',
  debugging_assistance public.assistance_level not null default 'none',
  explanation_assistance public.assistance_level not null default 'none',
  decisions text[] not null default '{}',
  blockers text[] not null default '{}',
  questions text[] not null default '{}',
  next_step text check (char_length(next_step) <= 2000),
  created_at timestamptz not null default now(),
  check (ended_at >= started_at),
  check (cardinality(providers) <= 20 and cardinality(models) <= 20),
  check (cardinality(decisions) <= 50 and cardinality(blockers) <= 50 and cardinality(questions) <= 50),
  check (char_length(array_to_string(providers, '')) <= 4000 and char_length(array_to_string(models, '')) <= 8000),
  check (char_length(array_to_string(decisions, '')) <= 20000 and char_length(array_to_string(blockers, '')) <= 20000 and char_length(array_to_string(questions, '')) <= 20000)
);

create table public.session_requirements (
  session_id uuid not null references public.sessions(id) on delete cascade,
  requirement_id uuid not null references public.project_requirements(id) on delete cascade,
  primary key (session_id, requirement_id)
);

create table public.session_standards (
  session_id uuid not null references public.sessions(id) on delete cascade,
  standard_id uuid not null references public.standards(id) on delete cascade,
  primary key (session_id, standard_id)
);

create table public.session_reflections (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  student_id uuid not null references public.profiles(id),
  accomplished text not null check (char_length(accomplished) <= 4000),
  important_decision text not null check (char_length(important_decision) <= 4000),
  still_unclear text not null check (char_length(still_unclear) <= 4000),
  next_step text not null check (char_length(next_step) <= 4000),
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table private.join_attempts (
  id bigint generated always as identity primary key,
  requester_id uuid not null,
  attempted_at timestamptz not null default now(),
  successful boolean not null
);

create index class_members_user_idx on public.class_members(user_id, status);
create index class_members_class_idx on public.class_members(class_id, status);
create index classes_teacher_idx on public.classes(teacher_id);
create index projects_class_idx on public.projects(class_id);
create index project_requirements_project_idx on public.project_requirements(project_id);
create index standards_class_idx on public.standards(class_id);
create index project_standards_standard_idx on public.project_standards(standard_id);
create index sessions_class_date_idx on public.sessions(class_id, started_at desc);
create index sessions_student_date_idx on public.sessions(student_id, started_at desc);
create index sessions_project_idx on public.sessions(project_id) where project_id is not null;
create index session_requirements_requirement_idx on public.session_requirements(requirement_id);
create index session_standards_standard_idx on public.session_standards(standard_id);
create index session_reflections_student_idx on public.session_reflections(student_id);
create index join_attempts_rate_idx on private.join_attempts(requester_id, attempted_at desc);

insert into public.profiles (id, display_name, email)
select id, coalesce(raw_user_meta_data ->> 'full_name', split_part(email, '@', 1)), email
from auth.users
on conflict (id) do nothing;

create or replace function private.is_class_teacher(class_id_input uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.classes c
    where c.id = class_id_input and c.teacher_id = (select auth.uid())
  );
$$;

create or replace function private.is_active_class_member(class_id_input uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.class_members cm
    where cm.class_id = class_id_input and cm.user_id = (select auth.uid()) and cm.status = 'active'
  );
$$;

create or replace function private.teacher_can_read_student(class_id_input uuid, student_id_input uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_class_teacher(class_id_input) and exists (
    select 1 from public.class_members cm
    where cm.class_id = class_id_input and cm.user_id = student_id_input
      and cm.role = 'student' and cm.status = 'active'
  );
$$;

revoke all on all functions in schema private from public, anon;
grant execute on function private.generate_join_code(), private.is_class_teacher(uuid), private.is_active_class_member(uuid), private.teacher_can_read_student(uuid, uuid) to authenticated;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger pi_student_on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();
revoke all on function private.handle_new_user() from public, anon, authenticated;

create or replace function private.add_teacher_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.class_members (class_id, user_id, role, status)
  values (new.id, new.teacher_id, 'teacher', 'active');
  return new;
end;
$$;

create trigger pi_student_on_class_created
after insert on public.classes
for each row execute function private.add_teacher_membership();
revoke all on function private.add_teacher_membership() from public, anon, authenticated;

create or replace function public.join_class(join_code_input text)
returns table (class_id uuid, membership_status public.membership_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  requester uuid := auth.uid();
  target_class uuid;
begin
  if requester is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requester::text, 0));
  delete from private.join_attempts where requester_id = requester and attempted_at <= now() - interval '1 day';
  if (select count(*) from private.join_attempts where requester_id = requester and attempted_at > now() - interval '15 minutes') >= 10 then
    raise exception 'Too many join attempts. Try again later.' using errcode = 'P0001';
  end if;
  select c.id into target_class from public.classes c
  where c.join_code = upper(trim(join_code_input))
    and c.join_enabled
    and (c.join_code_expires_at is null or c.join_code_expires_at > now());
  insert into private.join_attempts (requester_id, successful) values (requester, target_class is not null);
  -- Return no rows instead of raising so the failed-attempt audit row commits and
  -- can enforce the rate limit on the next call.
  if target_class is null then return; end if;
  insert into public.class_members as cm (class_id, user_id, role, status)
  values (target_class, requester, 'student', 'pending')
  on conflict on constraint class_members_class_id_user_id_key do update
    set status = case when cm.status = 'rejected' then 'pending' else cm.status end;
  return query select cm.class_id, cm.status from public.class_members cm
    where cm.class_id = target_class and cm.user_id = requester;
end;
$$;

create or replace function public.regenerate_class_join_code(class_id_input uuid, expires_at_input timestamptz default null)
returns table (join_code text, join_code_expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_class_teacher(class_id_input) then raise exception 'Teacher access required' using errcode = '42501'; end if;
  return query
    update public.classes c
      set join_code = private.generate_join_code(), join_code_expires_at = expires_at_input, join_enabled = true
      where c.id = class_id_input
      returning c.join_code, c.join_code_expires_at;
end;
$$;

revoke all on function public.join_class(text), public.regenerate_class_join_code(uuid, timestamptz) from public, anon;
grant execute on function public.join_class(text), public.regenerate_class_join_code(uuid, timestamptz) to authenticated;

alter table public.profiles enable row level security;
alter table public.classes enable row level security;
alter table public.class_members enable row level security;
alter table public.projects enable row level security;
alter table public.project_requirements enable row level security;
alter table public.standards enable row level security;
alter table public.project_standards enable row level security;
alter table public.sessions enable row level security;
alter table public.session_requirements enable row level security;
alter table public.session_standards enable row level security;
alter table public.session_reflections enable row level security;
alter table private.join_attempts enable row level security;

revoke all on table public.profiles, public.classes, public.class_members,
  public.projects, public.project_requirements, public.standards,
  public.project_standards, public.sessions, public.session_requirements,
  public.session_standards, public.session_reflections from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, display_name) on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, insert, delete on public.classes to authenticated;
grant update (name, join_enabled, join_code_expires_at) on public.classes to authenticated;
grant select on public.class_members to authenticated;
grant update (status) on public.class_members to authenticated;
grant select, insert, update, delete on public.projects, public.project_requirements, public.standards, public.project_standards to authenticated;
grant select, insert, update on public.sessions, public.session_reflections to authenticated;
grant select, insert on public.session_requirements, public.session_standards to authenticated;

create policy profiles_select on public.profiles for select to authenticated using (
  id = (select auth.uid()) or exists (
    select 1 from public.class_members cm join public.classes c on c.id = cm.class_id
    where cm.user_id = profiles.id and c.teacher_id = (select auth.uid())
  )
);
create policy profiles_insert_self on public.profiles for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_self on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy classes_select on public.classes for select to authenticated using (
  teacher_id = (select auth.uid()) or private.is_active_class_member(id)
);
create policy classes_insert_teacher on public.classes for insert to authenticated with check (teacher_id = (select auth.uid()));
create policy classes_update_teacher on public.classes for update to authenticated using (teacher_id = (select auth.uid())) with check (teacher_id = (select auth.uid()));
create policy classes_delete_teacher on public.classes for delete to authenticated using (teacher_id = (select auth.uid()));

create policy class_members_select on public.class_members for select to authenticated using (
  user_id = (select auth.uid()) or private.is_class_teacher(class_id)
);
create policy class_members_update_teacher on public.class_members for update to authenticated
  using (private.is_class_teacher(class_id) and role = 'student')
  with check (private.is_class_teacher(class_id) and role = 'student');

create policy projects_select on public.projects for select to authenticated using (
  private.is_class_teacher(class_id) or private.is_active_class_member(class_id)
);
create policy projects_insert_teacher on public.projects for insert to authenticated with check (private.is_class_teacher(class_id));
create policy projects_update_teacher on public.projects for update to authenticated using (private.is_class_teacher(class_id)) with check (private.is_class_teacher(class_id));
create policy projects_delete_teacher on public.projects for delete to authenticated using (private.is_class_teacher(class_id));

create policy requirements_select on public.project_requirements for select to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and (private.is_class_teacher(p.class_id) or private.is_active_class_member(p.class_id)))
);
create policy requirements_insert_teacher on public.project_requirements for insert to authenticated with check (
  exists (select 1 from public.projects p where p.id = project_id and private.is_class_teacher(p.class_id))
);
create policy requirements_update_teacher on public.project_requirements for update to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and private.is_class_teacher(p.class_id))
) with check (exists (select 1 from public.projects p where p.id = project_id and private.is_class_teacher(p.class_id)));
create policy requirements_delete_teacher on public.project_requirements for delete to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and private.is_class_teacher(p.class_id))
);

create policy standards_select on public.standards for select to authenticated using (
  private.is_class_teacher(class_id) or private.is_active_class_member(class_id)
);
create policy standards_insert_teacher on public.standards for insert to authenticated with check (private.is_class_teacher(class_id));
create policy standards_update_teacher on public.standards for update to authenticated using (private.is_class_teacher(class_id)) with check (private.is_class_teacher(class_id));
create policy standards_delete_teacher on public.standards for delete to authenticated using (private.is_class_teacher(class_id));

create policy project_standards_select on public.project_standards for select to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and (private.is_class_teacher(p.class_id) or private.is_active_class_member(p.class_id)))
);
create policy project_standards_insert_teacher on public.project_standards for insert to authenticated with check (
  exists (select 1 from public.projects p join public.standards s on s.class_id = p.class_id where p.id = project_id and s.id = standard_id and private.is_class_teacher(p.class_id))
);
create policy project_standards_update_teacher on public.project_standards for update to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and private.is_class_teacher(p.class_id))
) with check (exists (select 1 from public.projects p join public.standards s on s.class_id = p.class_id where p.id = project_id and s.id = standard_id and private.is_class_teacher(p.class_id)));
create policy project_standards_delete_teacher on public.project_standards for delete to authenticated using (
  exists (select 1 from public.projects p where p.id = project_id and private.is_class_teacher(p.class_id))
);

create policy sessions_select on public.sessions for select to authenticated using (
  student_id = (select auth.uid()) or private.teacher_can_read_student(class_id, student_id)
);
create policy sessions_insert_self on public.sessions for insert to authenticated with check (
  student_id = (select auth.uid()) and private.is_active_class_member(class_id)
  and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.class_id = class_id))
);
create policy sessions_update_self on public.sessions for update to authenticated using (student_id = (select auth.uid())) with check (
  student_id = (select auth.uid()) and private.is_active_class_member(class_id)
  and (project_id is null or exists (select 1 from public.projects p where p.id = project_id and p.class_id = class_id))
);

create policy session_requirements_select on public.session_requirements for select to authenticated using (
  exists (select 1 from public.sessions s where s.id = session_id and (s.student_id = (select auth.uid()) or private.teacher_can_read_student(s.class_id, s.student_id)))
);
create policy session_requirements_insert_self on public.session_requirements for insert to authenticated with check (
  exists (select 1 from public.sessions s join public.project_requirements r on r.project_id = s.project_id where s.id = session_id and r.id = requirement_id and s.student_id = (select auth.uid()))
);

create policy session_standards_select on public.session_standards for select to authenticated using (
  exists (select 1 from public.sessions s where s.id = session_id and (s.student_id = (select auth.uid()) or private.teacher_can_read_student(s.class_id, s.student_id)))
);
create policy session_standards_insert_self on public.session_standards for insert to authenticated with check (
  exists (select 1 from public.sessions s join public.standards st on st.class_id = s.class_id where s.id = session_id and st.id = standard_id and s.student_id = (select auth.uid()))
);

create policy reflections_select on public.session_reflections for select to authenticated using (
  exists (select 1 from public.sessions s where s.id = session_id and (s.student_id = (select auth.uid()) or private.teacher_can_read_student(s.class_id, s.student_id)))
);
create policy reflections_insert_self on public.session_reflections for insert to authenticated with check (
  student_id = (select auth.uid()) and exists (select 1 from public.sessions s where s.id = session_id and s.student_id = (select auth.uid()))
);
create policy reflections_update_self on public.session_reflections for update to authenticated using (student_id = (select auth.uid())) with check (
  student_id = (select auth.uid()) and exists (select 1 from public.sessions s where s.id = session_id and s.student_id = (select auth.uid()))
);

comment on table public.sessions is 'Structured learning metadata only. Source files, raw prompts, transcripts, credentials, and provider tokens are intentionally excluded.';
comment on table public.session_reflections is 'Student-authored reflection persisted only after explicit review and confirmation.';
