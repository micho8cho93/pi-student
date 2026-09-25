create or replace function public.class_capability_context(class_id_input uuid, project_id_input uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare org uuid; settings jsonb; layer record; paths text[]; setting_path text; keys text[]; proposed jsonb; current_value jsonb; next_value jsonb;
begin
 if not private.teacher_workspace_access(class_id_input) then raise exception 'Class management required' using errcode='42501'; end if;
 select organization_id into org from public.classes where id=class_id_input;
 if project_id_input is not null and not exists(select 1 from public.projects where id=project_id_input and class_id=class_id_input) then raise exception 'Project outside class'; end if;
 settings := '{"schemaVersion":1,"reasoningLevels":["off","minimal","low","medium","high","xhigh","max"],"models":[],"fileEditing":true,"terminal":true,"dependencyInstallation":true,"internet":true,"desktopExport":true,"imageUploads":true,"fileUploads":true,"reflection":true,"limits":{"minutes":null,"turns":null,"tokens":null,"cost":null},"accessibility":{"dictation":true,"cloudDictation":true,"readAloud":false,"simplifiedVocabulary":false,"readableFormatting":false}}'::jsonb;

 select delegated_paths into paths from public.governance_policies where organization_id=org and scope='organization';
 for layer in select g.settings from public.governance_policies g where g.organization_id=org and (g.scope='organization' or (g.scope='class' and g.class_id=class_id_input) or (g.scope='project' and g.project_id=project_id_input)) order by case g.scope when 'organization' then 1 when 'class' then 2 else 3 end loop
 for setting_path in select key from jsonb_object_keys(settings) key where key not in ('schemaVersion','limits','accessibility') union all select 'limits.'||key from jsonb_object_keys(settings->'limits') key union all select 'accessibility.'||key from jsonb_object_keys(settings->'accessibility') key loop
  keys:=string_to_array(setting_path,'.'); proposed:=layer.settings #> keys; current_value:=settings #> keys;
  if proposed is null or proposed='null'::jsonb then continue; end if;
  if jsonb_typeof(current_value)='boolean' then next_value:=to_jsonb((current_value::text)::boolean and (proposed::text)::boolean);
  elsif setting_path like 'limits.%' then next_value:=case when current_value='null'::jsonb then proposed else to_jsonb(least((current_value::text)::numeric,(proposed::text)::numeric)) end;
  elsif setting_path in ('models','reasoningLevels') then
   if setting_path='models' and current_value='[]'::jsonb then next_value:=proposed;
   else select coalesce(jsonb_agg(value),'[]'::jsonb) into next_value from jsonb_array_elements(current_value) where proposed @> jsonb_build_array(value); end if;
  else continue; end if;
  settings:=jsonb_set(settings,keys,next_value);
 end loop;
 end loop;
 return jsonb_build_object('settings',settings,'delegatedPaths',coalesce(paths,'{}'::text[]),'models',coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'name',m.display_name) order by m.display_name) from public.model_profiles m where m.organization_id=org and m.available),'[]'::jsonb));
end $$;
