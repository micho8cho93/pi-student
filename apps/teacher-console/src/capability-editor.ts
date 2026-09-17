import { ACCESSIBILITY_FIELDS, CAPABILITY_FIELDS, DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { THINKING_LEVELS } from "@pi-student/policy/thinking";

export function capabilityEditorScript(): string {
	return `
const capabilityDefaults=${JSON.stringify(DEFAULT_CAPABILITY_POLICY)};
const capabilityFields=${JSON.stringify(CAPABILITY_FIELDS)};
const accessibilityFields=${JSON.stringify(ACCESSIBILITY_FIELDS)};
const reasoningLevels=${JSON.stringify(THINKING_LEVELS)};
function renderCapabilityEditor(project){
 const settings=project.capability_policy||structuredClone(capabilityDefaults);
 const root=el('project-capabilities');root.replaceChildren();
 root.append(node('h3',{class:'full'},'Project capabilities'),node('p',{class:'muted full'},'These settings apply only to this project. Version '+(project.policy_version||1)+'. Changes apply when students load the project again.'));
 const reasoning=node('fieldset',{class:'full'},[node('legend',{},'Available reasoning levels'),node('p',{class:'muted'},'Choose any combination, with at least one level enabled. Students see only levels supported by their model.')]);
 for(const level of reasoningLevels){const input=node('input',{type:'checkbox',id:'cap-level-'+level});input.checked=settings.reasoningLevels.includes(level);reasoning.append(node('label',{style:'display:inline-flex;align-items:center;gap:8px;margin:8px'},[input,level]));}root.append(reasoning);
 const models=node('textarea',{id:'cap-models',class:'field textarea',placeholder:'provider/model-id, one per line'});models.value=settings.models.join('\\n');root.append(node('label',{class:'label full'},['Approved models',models,node('span',{class:'muted'},'Leave blank for student choice. One ID selects a single model; multiple IDs create an approved list.')]));
 function fields(list,values,prefix){for(const [key,label,help] of list){const input=node('input',{id:prefix+key,type:'checkbox'});input.checked=values[key];root.append(node('label',{class:'label',style:'display:flex;flex-direction:row;align-items:flex-start;gap:10px'},[input,node('span',{},[label,node('small',{class:'muted',style:'display:block'},help)])]));}}
 fields(capabilityFields,settings,'cap-');
 root.append(node('h3',{class:'full'},'Session limits'),node('p',{class:'muted full'},'Optional limits per recorded session. Blank means unlimited. Token and cost limits stop after a response and can exceed the limit by that response. Cost uses provider-reported USD estimates.'));
 for(const [key,label] of [['minutes','Minutes'],['turns','Model responses'],['tokens','Tokens'],['cost','Cost (USD)']]){const input=node('input',{id:'cap-limit-'+key,type:'number',class:'field',min:key==='cost'?'0.01':'1',max:'1000000000',step:key==='cost'?'0.01':'1'});input.value=settings.limits[key]??'';root.append(node('label',{class:'label'},[label,input]));}
 root.append(node('h3',{class:'full'},'Accessibility'),node('p',{class:'muted full'},'These accommodations support reading and input. They do not change editing permissions or other academic restrictions.'));
 fields(accessibilityFields,settings.accessibility,'cap-access-');
 const cloud=el('cap-access-cloudDictation');const dictation=el('cap-access-dictation');const refresh=()=>{cloud.disabled=!dictation.checked;};dictation.onchange=refresh;refresh();
}
function readCapabilityEditor(){
 const settings=structuredClone(capabilityDefaults);
 settings.reasoningLevels=reasoningLevels.filter(level=>el('cap-level-'+level).checked);
 if(!settings.reasoningLevels.length)throw new Error('Choose at least one reasoning level.');
 settings.models=el('cap-models').value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean);
 if(settings.models.some(x=>! /^[^\\s/]+\\/[^\\s]+$/.test(x)))throw new Error('Enter approved models as provider/model IDs.');
 for(const [key] of capabilityFields)settings[key]=el('cap-'+key).checked;
 for(const [key] of accessibilityFields)settings.accessibility[key]=el('cap-access-'+key).checked;
 for(const key of Object.keys(settings.limits)){const raw=el('cap-limit-'+key).value;settings.limits[key]=raw===''?null:Number(raw);}
 return settings;
}
function restrictCapabilityEditor(paths){
 const allowed=new Set(paths),root=el('project-capabilities');
 root.prepend(node('p',{class:'muted full'},'Your institution delegates only the controls shown below. Other settings are inherited from its policy.'));
 for(const [key] of capabilityFields){const input=el('cap-'+key);if(input)input.closest('label').style.display=allowed.has(key)?'':'none'}
 for(const [key] of accessibilityFields){const input=el('cap-access-'+key);if(input)input.closest('label').style.display=allowed.has('accessibility.'+key)?'':'none'}
 for(const key of ['minutes','turns','tokens','cost']){const input=el('cap-limit-'+key);if(input)input.closest('label').style.display=allowed.has('limits.'+key)?'':'none'}
 const models=el('cap-models');if(models)models.closest('label').style.display=allowed.has('models')?'':'none';
 const reasoning=el('cap-level-off');if(reasoning)reasoning.closest('fieldset').style.display=allowed.has('reasoningLevels')?'':'none';
}
function delegatedCapabilityPatch(settings,paths){
 const patch={};
 for(const path of paths){const parts=path.split('.');let value=parts.length===1?settings[parts[0]]:settings[parts[0]]?.[parts[1]];
  if(value===undefined||(path==='models'&&!value.length))continue;
  if(parts.length===1)patch[path]=value;else{patch[parts[0]]||={};patch[parts[0]][parts[1]]=value;}}
 return patch;
}
function policyHistoryNode(session){
 if(!session.effective_policy)return node('span',{},'Project policy: not recorded (older session)');
 const policy=session.effective_policy;const details=node('details',{},node('summary',{},'Project policy · version '+policy.version));
 details.append(node('pre',{style:'white-space:pre-wrap;overflow-wrap:anywhere'},JSON.stringify(policy.settings,null,2)));
 if(policy.provenance)details.append(node('pre',{style:'white-space:pre-wrap;overflow-wrap:anywhere'},JSON.stringify({sourceVersions:policy.sourceVersions,provenance:policy.provenance},null,2)));
 const blocked=session.policy_compliance&&session.policy_compliance.blockedActions||{};
 details.append(node('p',{},'Runtime-reported blocked actions: '+(Object.entries(blocked).map(([key,count])=>key+': '+count).join(', ')||'none recorded')));return details;
}
`;
}
