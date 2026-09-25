export const teacherSectionsScript = String.raw`
function fillTeacherClassSelect(id, managedOnly=false){
  const select=el(id),previous=select.value;
  const classes=allClasses.filter(item=>!managedOnly||item.organization_id);
  select.replaceChildren(...classes.map(item=>node('option',{value:item.id},item.name)));
  if(classes.some(item=>item.id===previous))select.value=previous;
  return classes;
}
function populateTeacherSections(){
  fillTeacherClassSelect('students-class');
  fillTeacherClassSelect('usage-class');
  fillTeacherClassSelect('models-class',true);
  fillTeacherClassSelect('skills-class',true);
  fillTeacherClassSelect('mcps-class',true);
}

el('side-models').onclick=()=>openTeacherModels();
el('models-class').onchange=()=>openTeacherModels(true);
el('models-project').onchange=loadTeacherModels;
async function openTeacherModels(resetProject=false){
  show('models-view');
  const classId=el('models-class').value,root=el('models-content');
  if(!classId){root.replaceChildren(node('div',{class:'notice'},'Choose a managed class to see approved providers.'));return}
  try{
    if(resetProject||!el('models-project').options.length){
      const projects=await fillTeacherProjectSelect(classId,'models-project','Choose a project');
      if(projects.length&&!el('models-project').value)el('models-project').value=projects[0].id;
    }
    await loadTeacherModels();
  }catch(error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(error)))}
}
async function loadTeacherModels(){
  const projectId=el('models-project').value,root=el('models-content');
  if(!projectId){root.replaceChildren(node('div',{class:'notice'},'Add a project to this class to see its approved providers.'));return}
  root.textContent='Loading providers…';
  const {data,error}=await db.rpc('approved_provider_ids',{project_id_input:projectId});
  if(el('models-project').value!==projectId)return;
  if(error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(error)));return}
  const rows=providerCatalog.filter(item=>(data||[]).includes(item.id));
  const panel=node('div',{class:'panel'},[node('h2',{},'Available to connect'),node('p',{class:'muted'},'Open Pi Student’s Models settings to connect with your own API key or account. Other providers are hidden for this organization.')]);
  if(!rows.length)panel.append(node('div',{class:'notice'},'Your school has not approved any model providers yet.'));
  for(const item of rows)panel.append(node('div',{class:'extension-row'},[node('strong',{},item.name),node('small',{class:'muted'},item.connection)]));
  root.replaceChildren(panel);
}
async function fillTeacherProjectSelect(classId,selectId,allLabel){
  const select=el(selectId),previous=select.value;
  select.dataset.classId=classId;
  select.replaceChildren(node('option',{value:''},allLabel));
  if(!classId)return [];
  const {data,error}=await db.from('projects').select('id,name,capability_policy,policy_version')
    .eq('class_id',classId).order('name');
  if(error)throw error;
  if(select.dataset.classId!==classId)return [];
  for(const project of data||[])select.append(node('option',{value:project.id},project.name));
  if((data||[]).some(item=>item.id===previous))select.value=previous;
  return data||[];
}

el('side-students').onclick=loadTeacherStudents;
el('students-class').onchange=loadTeacherStudents;
async function loadTeacherStudents(){
  show('students-view');
  const root=el('students-content'),classId=el('students-class').value;
  const selected=allClasses.find(item=>item.id===classId);
  if(!selected){root.replaceChildren(node('div',{class:'notice'},'Create a class to manage its students.'));return}
  root.textContent='Loading students…';
  const {data,error}=await db.from('class_members')
    .select('id,user_id,role,status,joined_at,profiles(display_name,email)')
    .eq('class_id',classId).eq('role','student').order('joined_at',{ascending:false});
  if(el('students-class').value!==classId)return;
  if(error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(error)));return}
  const table=node('table',{class:'data-table'});
  table.append(node('thead',{},node('tr',{},['Student','Class','Status','Joined','Actions'].map(value=>node('th',{},value)))));
  const body=node('tbody');
  if(!data?.length)body.append(node('tr',{},node('td',{class:'empty-cell',colspan:'5'},'No students have joined this class. Share its join code from Classes.')));
  for(const member of data||[]){
    const name=member.profiles?.display_name||member.profiles?.email||member.user_id;
    const badge=node('span',{class:'badge '+(member.status==='active'?'success':member.status==='pending'?'warning':'danger')},member.status);
    const actions=node('div',{class:'project-actions'});
    if(member.status!=='active')actions.append(node('button',{class:'btn small',onclick:()=>changeTeacherStudent(member,'active')},'Approve'));
    if(member.status!=='rejected')actions.append(node('button',{class:'btn small ghost',onclick:()=>changeTeacherStudent(member,'rejected')},member.status==='pending'?'Reject':'Remove access'));
    if(member.status==='active')actions.append(node('button',{class:'btn small ghost',onclick:()=>{currentClass=selected;openStudent(member.user_id,member.profiles)}},'View evidence'));
    body.append(node('tr',{},[node('td',{class:'primary-cell'},name),node('td',{},selected.name),node('td',{},badge),node('td',{},new Date(member.joined_at).toLocaleDateString()),node('td',{class:'action-cell'},actions)]));
  }
  table.append(body);
  root.replaceChildren(node('div',{class:'panel'},[node('div',{class:'panel-head'},[node('div',{},[node('h2',{},'Class roster'),node('p',{},'Changes to access apply to the selected class.')]),node('span',{class:'badge'},(data||[]).length+' students')]),node('div',{class:'table-shell'},table)]));
}
async function changeTeacherStudent(member,status){
  const classId=el('students-class').value;
  const {error}=await db.from('class_members').update({status}).eq('id',member.id).eq('class_id',classId).eq('role','student').select('id').single();
  if(error){alert(errorMessage(error));return}
  await loadTeacherStudents();
}

for(const kind of ['skills','mcps']){
  el('side-'+kind).onclick=()=>openTeacherExtensions(kind);
  el(kind+'-class').onchange=()=>openTeacherExtensions(kind,true);
  el(kind+'-project').onchange=()=>loadTeacherExtensions(kind);
}
async function openTeacherExtensions(kind,resetProject=false){
  show(kind+'-view');
  const classId=el(kind+'-class').value,root=el(kind+'-content');
  if(!classId){root.replaceChildren(node('div',{class:'notice'},'Approved school '+(kind==='skills'?'skills':'MCPs')+' are available for managed classes.'));return}
  try{
    if(resetProject||!el(kind+'-project').options.length)await fillTeacherProjectSelect(classId,kind+'-project','Whole class');
    if(el(kind+'-class').value!==classId)return;
    await loadTeacherExtensions(kind);
  }catch(error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(error)))}
}
async function loadTeacherExtensions(kind){
  const classId=el(kind+'-class').value,projectId=el(kind+'-project').value||null,root=el(kind+'-content');
  if(!classId)return;
  root.textContent='Loading approved '+(kind==='skills'?'skills':'MCPs')+'…';
  const {data,error}=await db.rpc('teacher_extension_catalog',{class_id_input:classId,project_id_input:projectId});
  if(el(kind+'-class').value!==classId||el(kind+'-project').value!==(projectId||''))return;
  if(error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(error)));return}
  const rows=(Array.isArray(data)?data:[]).filter(item=>item.kind===(kind==='skills'?'skill':'mcp'));
  if(!rows.length){root.replaceChildren(node('div',{class:'notice'},'No approved '+(kind==='skills'?'skills':'MCPs')+' are available for this '+(projectId?'project':'class')+'. Your school administrator manages the approved catalog.'));return}
  const list=node('div',{class:'extension-list'});
  const changed=new Map();
  for(const item of rows){
    const granted=projectId?item.projectGranted:item.classGranted;
    const inherited=!!projectId&&item.classGranted;
    const input=node('input',{type:'checkbox','aria-label':'Allow '+item.name+' for '+(projectId?'project':'class')});
    input.checked=!!granted||inherited;input.disabled=inherited;
    input.onchange=()=>{changed.set(item.id,{item,enabled:input.checked});settingsNote(kind+'-note','Unsaved changes.');};
    const description=item.description||((item.capabilities||[]).length?'Capabilities: '+item.capabilities.join(', '):'Approved by your school');
    list.append(node('label',{class:'extension-row'},[node('span',{},[node('strong',{},item.name+' · '+item.version),node('small',{},description),node('small',{class:'muted'},inherited?'Allowed for the whole class':item.scope+' scope')]),input]));
  }
  const save=node('button',{class:'btn primary',type:'button'},'Save selections');
  save.onclick=async()=>{
    save.disabled=true;
    try{
      for(const {item,enabled} of changed.values()){
        const {error}=await db.rpc('set_teacher_extension_enabled',{class_id_input:classId,project_id_input:projectId,kind_input:item.kind,extension_id_input:item.id,enabled_input:enabled});
        if(error)throw error;
      }
      settingsNote(kind+'-note','Selections saved.');
      await loadTeacherExtensions(kind);
    }catch(error){settingsNote(kind+'-note',errorMessage(error),true);save.disabled=false}
  };
  root.replaceChildren(node('div',{class:'panel'},[node('div',{class:'panel-head'},[node('div',{},[node('h2',{},projectId?'Project availability':'Class availability'),node('p',{},'Check a box to give students access. Class approvals also apply to every project in the class.')])]),list,save]));
}

let usageProjects=[];
el('side-usage').onclick=()=>openTeacherUsage();
el('usage-class').onchange=()=>openTeacherUsage(true);
el('usage-project').onchange=loadTeacherUsage;
el('usage-range').onchange=loadTeacherUsage;
async function openTeacherUsage(resetProject=false){
  show('usage-view');
  const classId=el('usage-class').value;
  if(!classId){el('usage-content').replaceChildren(node('div',{class:'notice'},'Create a class to review usage.'));el('usage-limits').replaceChildren();return}
  try{
    if(resetProject||!el('usage-project').options.length){
      const projects=await fillTeacherProjectSelect(classId,'usage-project','All projects');
      if(el('usage-class').value!==classId)return;
      usageProjects=projects;
    }
    await loadTeacherUsage();
  }catch(error){el('usage-content').replaceChildren(node('div',{class:'notice error'},errorMessage(error)))}
}
async function loadTeacherUsage(){
  const classId=el('usage-class').value,projectId=el('usage-project').value||null;
  const root=el('usage-content');root.textContent='Loading usage…';
  const date=new Date();date.setDate(date.getDate()-Number(el('usage-range').value)+1);
  const fromDay=date.toISOString().slice(0,10);
  const {data,error}=await db.rpc('teacher_usage_summary',{class_id_input:classId,project_id_input:projectId,from_day_input:fromDay});
  if(el('usage-class').value!==classId||el('usage-project').value!==(projectId||''))return;
  if(error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(error)));return}
  const metrics=[metricItem(Number(data.students||0).toLocaleString(),'Students','active in period'),metricItem(Number(data.sessions||0).toLocaleString(),'Sessions','recorded'),metricItem(Number(data.minutes||0).toLocaleString(),'Minutes','recorded'),metricItem(Number(data.tokens||0).toLocaleString(),'Tokens','input + output')];
  if(data.knownCostMicros!=null)metrics.push(metricItem('$'+(Number(data.knownCostMicros)/1000000).toFixed(2),'Known cost',Number(data.unknownCostCount||0)+' unpriced events'));
  root.replaceChildren(node('div',{class:'usage-metrics'},metrics));
  await renderTeacherUsageLimits(classId,projectId);
}
async function renderTeacherUsageLimits(classId,projectId){
  const root=el('usage-limits');
  if(!projectId){root.replaceChildren(node('div',{class:'notice'},'Choose a project to set its per-session limits.'));return}
  root.textContent='Loading project limits…';
  const selectedClass=allClasses.find(item=>item.id===classId);
  const project=usageProjects.find(item=>item.id===projectId);
  if(!project){root.replaceChildren(node('div',{class:'notice error'},'Project details could not be loaded. Select the class again.'));return}
  let existing={},delegated=['limits.minutes','limits.turns','limits.tokens','limits.cost'];
  if(selectedClass?.organization_id){
    const {data,error}=await db.rpc('governance_context',{project_id_input:projectId});
    if(error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(error)));return}
    existing=structuredClone((data.layers||[]).find(item=>item.scope==='project')?.settings||{});
    delegated=(data.layers||[]).find(item=>item.scope==='organization')?.delegatedPaths||[];
  }
  if(el('usage-project').value!==projectId)return;
  const allowed=['minutes','turns','tokens','cost'].filter(key=>delegated.includes('limits.'+key));
  if(!allowed.length){root.replaceChildren(node('div',{class:'notice'},'Your school manages this project’s usage limits.'));return}
  const form=node('form',{class:'panel usage-limit-form'},[node('h2',{},'Project session limits'),node('p',{class:'muted'},'Blank values inherit school limits in managed classes or remain unlimited in standalone classes. Token and cost limits are checked after a model response.')]);
  const fields=node('div',{class:'limit-fields'});
  for(const [key,label] of [['minutes','Minutes'],['turns','Model responses'],['tokens','Tokens'],['cost','Cost (USD)']]){
    if(!allowed.includes(key))continue;
    const input=node('input',{name:key,class:'field',type:'number',min:key==='cost'?'0.01':'1',max:'1000000000',step:key==='cost'?'0.01':'1'});
    input.value=selectedClass?.organization_id?(existing.limits?.[key]??''):(project.capability_policy?.limits?.[key]??'');
    fields.append(node('label',{class:'label'},[label,input]));
  }
  const status=node('span',{class:'settings-note','role':'status','aria-live':'polite'});
  const save=node('button',{class:'btn primary',type:'submit'},'Save limits');
  form.append(fields,node('div',{class:'limit-actions'},[save,status]));
  form.onsubmit=async event=>{
    event.preventDefault();save.disabled=true;
    try{
      const values={};
      for(const key of allowed){const raw=form.elements.namedItem(key).value;values[key]=raw===''?null:Number(raw)}
      let result,nextSettings;
      if(selectedClass?.organization_id){
        const settings=structuredClone(existing);settings.limits={...(settings.limits||{})};
        for(const key of allowed){if(values[key]===null)delete settings.limits[key];else settings.limits[key]=values[key]}
        if(!Object.keys(settings.limits).length)delete settings.limits;
        nextSettings=settings;
        result=await db.rpc('save_governance_policy',{organization_id_input:selectedClass.organization_id,scope_input:'project',class_id_input:classId,project_id_input:projectId,settings_input:settings,delegated_paths_input:[]});
      }else{
        const policy=structuredClone(project.capability_policy||capabilityDefaults);
        for(const key of allowed)policy.limits[key]=values[key];
        result=await db.from('projects').update({capability_policy:policy}).eq('id',projectId).eq('class_id',classId).select('id,capability_policy,policy_version').single();
        if(!result.error)Object.assign(project,result.data);
      }
      if(result.error)throw result.error;
      status.textContent='Limits saved.';status.classList.remove('error');
      if(selectedClass?.organization_id)existing=nextSettings;
    }catch(error){status.textContent=errorMessage(error);status.classList.add('error')}
    finally{save.disabled=false}
  };
  root.replaceChildren(form);
}
`;
