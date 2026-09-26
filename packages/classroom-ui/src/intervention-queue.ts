/** Browser code injected into the teacher dashboard module. */
export const interventionQueueScript = `
el('side-interventions').onclick=()=>openInterventions();
el('interventions-class').onchange=()=>loadInterventions();
el('interventions-status').onchange=()=>loadInterventions();

function interventionPriority(item){return node('span',{class:'badge '+(item.priority==='high'?'danger':item.priority==='medium'?'warning':'accent')},item.priority.charAt(0).toUpperCase()+item.priority.slice(1))}
function interventionTitle(category){return ({repeated_failures:'Repeated test failures',agent_edit_balance:'Agent edit balance',missing_reflection:'Reflection to check',ready_for_review:'Ready for review'})[category]||'Recorded signal'}
async function openInterventions(selectedClassId){
  show('interventions-view');
  const select=el('interventions-class'),previous=selectedClassId||select.value;
  select.replaceChildren(...allClasses.map(item=>node('option',{value:item.id},item.name)));
  if(allClasses.some(item=>item.id===previous))select.value=previous;
  await loadInterventions();
}
async function loadInterventions(){
  const root=el('interventions-content'),classId=el('interventions-class').value,status=el('interventions-status').value;
  if(!classId||!allClasses.some(item=>item.id===classId)){root.replaceChildren(node('div',{class:'notice'},'Choose a class to see its review queue.'));return}
  root.textContent='Checking recorded evidence…';
  const refresh=await db.rpc('refresh_teacher_interventions',{class_id_input:classId});
  if(refresh.error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(refresh.error)));return}
  const {data,error}=await db.from('intervention_items').select('id,class_id,project_id,student_id,session_id,category,priority,explanation,evidence,status,teacher_note,created_at,resolved_at,profiles!intervention_items_student_id_fkey(display_name,email),projects(name)').eq('class_id',classId).eq('status',status).order('created_at',{ascending:false}).limit(200);
  if(el('interventions-class').value!==classId||el('interventions-status').value!==status)return;
  if(error){root.replaceChildren(node('div',{class:'notice error'},errorMessage(error)));return}
  if(!data?.length){root.replaceChildren(node('div',{class:'notice'},status==='open'?'No open review items for this class.':'No '+status+' items for this class.'));return}
  const priorityOrder={high:0,medium:1,low:2};
  data.sort((a,b)=>(priorityOrder[a.priority]??3)-(priorityOrder[b.priority]??3)||new Date(b.created_at)-new Date(a.created_at));
  const rows=[];
  for(const item of data){
    const name=item.profiles?.display_name||item.profiles?.email||'Student';
    const heading=node('div',{class:'intervention-heading'},[node('div',{},[node('strong',{},name),node('span',{class:'muted'},' · '+(item.projects?.name||'Project'))]),interventionPriority(item)]);
    const detail=node('details',{},[node('summary',{},'Inspect recorded counts'),node('div',{class:'intervention-facts'},Object.entries(item.evidence||{}).map(([key,value])=>node('span',{},key.replace(/([A-Z])/g,' $1')+': '+(value===null?'none':String(value))))) ]);
    const note=node('textarea',{class:'field textarea',maxlength:'2000','aria-label':'Teacher note for '+name,placeholder:'Private teacher note'});note.value=item.teacher_note||'';
    const message=node('div',{class:'settings-note',role:'status'});
    const save=node('button',{class:'btn small',type:'button',onclick:async()=>{const result=await db.from('intervention_items').update({teacher_note:note.value.trim()}).eq('id',item.id).eq('class_id',classId);message.textContent=result.error?errorMessage(result.error):'Note saved.';}},'Save note');
    const inspect=node('button',{class:'btn small',type:'button',onclick:async()=>{const target=allClasses.find(c=>c.id===classId);if(!target)return;await openClass(target);await openStudent(item.student_id,item.profiles,item.project_id);el('evidence-session').value=item.session_id;await loadEvidenceTimeline();}},'View session evidence');
    const actions=[inspect,save];
    if(status==='open')for(const choice of ['dismissed','resolved'])actions.push(node('button',{class:'btn small ghost',type:'button',onclick:async()=>{const result=await db.from('intervention_items').update({status:choice,teacher_note:note.value.trim()}).eq('id',item.id).eq('class_id',classId);if(result.error)message.textContent=errorMessage(result.error);else await loadInterventions();}},choice==='dismissed'?'Dismiss':'Resolve'));
    rows.push(node('article',{class:'panel intervention-item'},[heading,node('h2',{},interventionTitle(item.category)),node('p',{},item.explanation),node('p',{class:'muted'},'Created '+new Date(item.created_at).toLocaleString()+(item.resolved_at?' · Closed '+new Date(item.resolved_at).toLocaleString():'')),detail,node('label',{class:'label'},['Teacher note',note]),node('div',{class:'intervention-actions'},actions),message]));
  }
  if(data.length===200)rows.push(node('p',{class:'muted'},'Showing 200 most recent items. Narrow to one class or status.'));
  root.replaceChildren(...rows);
}
`;
