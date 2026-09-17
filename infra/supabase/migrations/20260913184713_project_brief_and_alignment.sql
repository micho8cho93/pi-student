alter table public.projects
  add column if not exists brief jsonb not null default '{}'::jsonb;

comment on column public.projects.brief is
  'Structured teacher-authored project brief produced by the conversational project builder.';
