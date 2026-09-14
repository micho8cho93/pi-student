-- Existing projects retain their current capabilities. Policies are project-owned.
alter table public.projects
  add column capability_policy jsonb not null default '{"schemaVersion":1,"reasoningLevels":["off","minimal","low","medium","high","xhigh","max"],"models":[],"fileEditing":true,"terminal":true,"dependencyInstallation":true,"internet":true,"desktopExport":true,"imageUploads":true,"fileUploads":true,"reflection":true,"limits":{"minutes":null,"turns":null,"tokens":null,"cost":null},"accessibility":{"dictation":true,"cloudDictation":true,"readAloud":false,"simplifiedVocabulary":false,"readableFormatting":false}}'::jsonb,
  add column policy_version integer not null default 1 check (policy_version > 0);
alter table public.sessions
  add column effective_policy jsonb,
  add column policy_compliance jsonb;
comment on column public.sessions.effective_policy is 'Versioned project settings used by this session. No prompts, transcripts or student files.';
comment on column public.sessions.policy_compliance is 'Runtime-reported aggregate blocked action counts, not a grade or a tamper-proof attestation.';

create or replace function private.validate_capability_policy(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare k text; v jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' or p->'schemaVersion' is distinct from '1'::jsonb then return false; end if;
  if jsonb_typeof(p->'reasoningLevels') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p->'reasoningLevels') < 1 or jsonb_array_length(p->'reasoningLevels') > 7 then return false; end if;
  for v in select * from jsonb_array_elements(p->'reasoningLevels') loop
    if not (v <@ '["off","minimal","low","medium","high","xhigh","max"]'::jsonb) then return false; end if;
  end loop;
  if jsonb_typeof(p->'models') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p->'models') > 30 then return false; end if;
  for v in select * from jsonb_array_elements(p->'models') loop
    if jsonb_typeof(v) <> 'string' or length(v #>> '{}') > 200 or (v #>> '{}') !~ '^[^[:space:]/]+/[^[:space:]]+$' then return false; end if;
  end loop;
  foreach k in array array['fileEditing','terminal','dependencyInstallation','internet','desktopExport','imageUploads','fileUploads','reflection'] loop
    if jsonb_typeof(p->k) is distinct from 'boolean' then return false; end if;
  end loop;
  foreach k in array array['dictation','cloudDictation','readAloud','simplifiedVocabulary','readableFormatting'] loop
    if jsonb_typeof(p->'accessibility'->k) is distinct from 'boolean' then return false; end if;
  end loop;
  foreach k in array array['minutes','turns','tokens','cost'] loop
    v := p->'limits'->k;
    if v is null then return false; end if;
    if v <> 'null'::jsonb then
      if jsonb_typeof(v) <> 'number' then return false; end if;
      if (v::text)::numeric <= 0 or (v::text)::numeric > 1000000000 then return false; end if;
      if k <> 'cost' and trunc((v::text)::numeric) <> (v::text)::numeric then return false; end if;
    end if;
  end loop;
  return true;
end;
$$;
revoke all on function private.validate_capability_policy(jsonb) from public, anon;
grant execute on function private.validate_capability_policy(jsonb) to authenticated;
alter table public.projects add constraint valid_capability_policy check (private.validate_capability_policy(capability_policy));

create or replace function private.version_project_capabilities()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then new.policy_version := 1;
  elsif new.capability_policy is distinct from old.capability_policy then new.policy_version := old.policy_version + 1;
  else new.policy_version := old.policy_version;
  end if;
  return new;
end;
$$;
revoke all on function private.version_project_capabilities() from public, anon, authenticated;
create trigger version_project_capabilities before insert or update on public.projects
for each row execute function private.version_project_capabilities();

create or replace function private.preserve_session_policy()
returns trigger language plpgsql set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' and old.effective_policy is not null and
    (new.effective_policy is distinct from old.effective_policy or new.project_id is distinct from old.project_id or new.class_id is distinct from old.class_id) then
    raise exception 'The effective policy and project of a recorded session cannot change';
  end if;
  if new.effective_policy is not null then
    if new.project_id is null or new.effective_policy->>'projectId' is distinct from new.project_id::text or
      not private.validate_capability_policy(new.effective_policy->'settings') or
      jsonb_typeof(new.effective_policy->'version') is distinct from 'number' then
      raise exception 'Invalid effective project policy';
    end if;
    if (new.effective_policy->>'version')::numeric < 1 or
      trunc((new.effective_policy->>'version')::numeric) <> (new.effective_policy->>'version')::numeric then
      raise exception 'Invalid policy version';
    end if;
    if not exists(select 1 from public.projects p where p.id = new.project_id and p.class_id = new.class_id) then
      raise exception 'Policy project does not belong to the session class';
    end if;
  end if;
  if new.policy_compliance is not null then
    if jsonb_typeof(new.policy_compliance->'blockedActions') is distinct from 'object' or length(new.policy_compliance::text) > 4000 then
      raise exception 'Invalid policy compliance summary';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function private.preserve_session_policy() from public, anon, authenticated;
create trigger preserve_session_policy before insert or update on public.sessions
for each row execute function private.preserve_session_policy();
