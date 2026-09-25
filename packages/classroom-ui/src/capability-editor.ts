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
 let models;
 if(project.approvedModels){models=node('select',{id:'cap-models',class:'field',multiple:true,size:Math.min(6,Math.max(2,project.approvedModels.length))});for(const model of project.approvedModels){const option=node('option',{value:'institution/'+model.id},model.name);option.selected=settings.models.includes(option.value);models.append(option)}}
 else{models=node('textarea',{id:'cap-models',class:'field textarea',placeholder:'provider/model-id, one per line'});models.value=settings.models.join('\\n')}
 root.append(node('label',{class:'label full'},['Approved models',models,node('span',{class:'muted'},project.approvedModels?'Select models, or leave all unselected to inherit the school model list.':'Leave blank for student choice. One ID selects a single model; multiple IDs create an approved list.')]));
 function fields(list,values,prefix){for(const [key,label,help] of list){const input=node('input',{id:prefix+key,type:'checkbox'});input.checked=values[key];root.append(node('label',{class:'label',style:'display:flex;flex-direction:row;align-items:flex-start;gap:10px'},[input,node('span',{},[label,node('small',{class:'muted',style:'display:block'},help)])]));}}
 fields(capabilityFields,settings,'cap-');
 root.append(node('h3',{class:'full'},'Session limits'),node('p',{class:'muted full'},'Optional limits per recorded session. Blank means unlimited. Agent minutes and responses limit the AI doing the work; after them the AI switches to tutoring (explanations and hints, no file edits or commands) for the tutoring responses allowed. Token and cost limits stop all AI after a response and can exceed the limit by that response. Cost uses provider-reported USD estimates.'));
 for(const [key,label] of [['minutes','Agent minutes'],['turns','Agent responses'],['tutoringTurns','Tutoring responses after agent limit'],['tokens','Tokens'],['cost','Cost (USD)']]){const input=node('input',{id:'cap-limit-'+key,type:'number',class:'field',min:key==='cost'?'0.01':'1',max:'1000000000',step:key==='cost'?'0.01':'1'});input.value=settings.limits[key]??'';root.append(node('label',{class:'label'},[label,input]));}
 root.append(node('h3',{class:'full'},'Accessibility'),node('p',{class:'muted full'},'These accommodations support reading and input. They do not change editing permissions or other academic restrictions.'));
 fields(accessibilityFields,settings.accessibility,'cap-access-');
 const cloud=el('cap-access-cloudDictation');const dictation=el('cap-access-dictation');const refresh=()=>{cloud.disabled=cloud.dataset.managed==='true'||!dictation.checked;};dictation.onchange=refresh;refresh();
}
function readCapabilityEditor(){
 const settings=structuredClone(capabilityDefaults);
 settings.reasoningLevels=reasoningLevels.filter(level=>el('cap-level-'+level).checked);
 if(!settings.reasoningLevels.length)throw new Error('Choose at least one reasoning level.');
 const models=el('cap-models');settings.models=models.tagName==='SELECT'?[...models.selectedOptions].map(option=>option.value):models.value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean);
 if(settings.models.some(x=>! /^[^\\s/]+\\/[^\\s]+$/.test(x)))throw new Error('Enter approved models as provider/model IDs.');
 for(const [key] of capabilityFields)settings[key]=el('cap-'+key).checked;
 for(const [key] of accessibilityFields)settings.accessibility[key]=el('cap-access-'+key).checked;
 for(const key of ['minutes','turns','tutoringTurns','tokens','cost']){const raw=el('cap-limit-'+key).value;settings.limits[key]=raw===''?null:Number(raw);}
 return settings;
}
function restrictCapabilityEditor(paths){
 const allowed=new Set(paths),root=el('project-capabilities');
 root.prepend(node('p',{class:'muted full'},'Disabled controls are managed by your organization. Available controls can be changed for this project.'));
 for(const input of root.querySelectorAll('input,textarea,select')){let path=input.id.replace('cap-access-','accessibility.').replace('cap-limit-','limits.').replace('cap-','');if(input.id.startsWith('cap-level-'))path='reasoningLevels';if(!allowed.has(path)){input.disabled=true;input.dataset.managed='true';input.title='Managed by your organization';input.closest('label,fieldset')?.classList.add('muted')}}
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
