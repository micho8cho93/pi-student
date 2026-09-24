export const teacherSettingsScript = String.raw`
let teacherUser=null;
let teacherPreferences={theme:'system',density:'comfortable',default_join_enabled:true,overview_days:14};
function settingsNote(id,message,isError=false){const target=el(id);target.textContent=message;target.classList.toggle('error',isError)}
function applyTeacherAppearance(){const deviceDark=window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=teacherPreferences.theme==='system'?(deviceDark?'dark':'light'):teacherPreferences.theme;document.documentElement.dataset.density=teacherPreferences.density}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTeacherAppearance);
async function loadTeacherSettings(){
  const {data:auth,error:authError}=await db.auth.getUser();
  if(authError||!auth.user){settingsNote('profile-note',errorMessage(authError||new Error('Sign in again to load settings.')),true);return}
  teacherUser=auth.user;el('settings-email').value=teacherUser.email||'';
  const [profileResult,preferencesResult]=await Promise.all([
    db.from('profiles').select('display_name').eq('id',teacherUser.id).maybeSingle(),
    db.from('teacher_preferences').select('theme,density,default_join_enabled,overview_days').eq('user_id',teacherUser.id).maybeSingle()
  ]);
  if(profileResult.error)settingsNote('profile-note',errorMessage(profileResult.error),true);
  else el('settings-name').value=profileResult.data&&profileResult.data.display_name||teacherUser.user_metadata&&teacherUser.user_metadata.full_name||'';
  if(preferencesResult.error)settingsNote('preferences-note',errorMessage(preferencesResult.error),true);
  else if(preferencesResult.data)teacherPreferences={...teacherPreferences,...preferencesResult.data};
  el('settings-theme').value=teacherPreferences.theme;el('settings-density').value=teacherPreferences.density;
  el('settings-overview-days').value=String(teacherPreferences.overview_days);
  el('settings-default-join').checked=teacherPreferences.default_join_enabled;
  applyTeacherAppearance();renderTeacherClasses();
}
el('side-classes').onclick=loadClasses;
el('side-settings').onclick=()=>{show('settings-view');renderTeacherClasses()};
el('profile-form').onsubmit=async event=>{
  event.preventDefault();const name=el('settings-name').value.trim();if(!name||!teacherUser)return;
  const button=event.submitter;button.disabled=true;
  const {error}=await db.from('profiles').update({display_name:name}).eq('id',teacherUser.id).select('id').single();
  settingsNote('profile-note',error?errorMessage(error):'Profile saved.',!!error);button.disabled=false;
};
el('preferences-form').onsubmit=async event=>{
  event.preventDefault();if(!teacherUser)return;const button=event.submitter;button.disabled=true;
  const values={user_id:teacherUser.id,theme:el('settings-theme').value,density:el('settings-density').value,overview_days:Number(el('settings-overview-days').value),default_join_enabled:el('settings-default-join').checked,updated_at:new Date().toISOString()};
  const {error}=await db.from('teacher_preferences').upsert(values,{onConflict:'user_id'});
  if(!error){teacherPreferences={...teacherPreferences,...values};applyTeacherAppearance()}
  settingsNote('preferences-note',error?errorMessage(error):'Preferences saved.',!!error);button.disabled=false;
};
function renderTeacherClasses(){
  const root=el('settings-classes');
  if(!allClasses.length){root.replaceChildren(node('p',{class:'muted'},'You do not have any classes yet.'));return}
  root.replaceChildren(...allClasses.map(item=>{
    const name=node('input',{class:'field',maxlength:'160','aria-label':'Name for '+item.name});name.value=item.name;
    const joining=node('input',{type:'checkbox','aria-label':'Allow students to join '+item.name});joining.checked=item.join_enabled;
    const status=node('span',{class:'settings-note','role':'status','aria-live':'polite'});
    const save=node('button',{class:'btn small',type:'submit'},'Save class');
    const form=node('form',{class:'settings-class-row'},[node('label',{class:'label'},[node('span',{},'Class name'),name]),node('label',{class:'check-field'},[joining,'Joining by code']),save,status]);
    form.onsubmit=async event=>{
      event.preventDefault();const value=name.value.trim();if(!value){status.textContent='Enter a class name.';status.classList.add('error');return}
      save.disabled=true;const {error}=await db.from('classes').update({name:value,join_enabled:joining.checked}).eq('id',item.id).select('id').single();
      status.textContent=error?errorMessage(error):'Saved.';status.classList.toggle('error',!!error);save.disabled=false;
      if(!error){item.name=value;item.join_enabled=joining.checked;if(currentClass&&currentClass.id===item.id){currentClass.name=value;currentClass.join_enabled=joining.checked;el('class-name').textContent=value;el('class-meta').textContent=(joining.checked?'Students can join':'Joining is paused')+' · Activity window: last '+teacherPreferences.overview_days+' days'}renderClasses()}
    };
    return form;
  }));
}
const deleteDialog=el('delete-account-dialog');
function closeDeleteDialog(){deleteDialog.close()}
el('delete-account').onclick=()=>{
  if(!teacherUser){settingsNote('profile-note','Sign in again before deleting your account.',true);return}
  const phrase='I confirm that I am deleting '+(teacherUser.email||'');
  el('delete-account-phrase').textContent=phrase;el('delete-account-input').value='';el('delete-account-understood').checked=false;
  el('delete-account-step-one').classList.remove('hidden');el('delete-account-step-two').classList.add('hidden');
  el('next-delete-account').disabled=true;el('confirm-delete-account').disabled=true;
  settingsNote('delete-account-error','');deleteDialog.showModal();el('delete-account-input').focus();
};
el('close-delete-account').onclick=closeDeleteDialog;
el('cancel-delete-account-one').onclick=closeDeleteDialog;
el('delete-account-input').oninput=()=>{el('next-delete-account').disabled=el('delete-account-input').value!==el('delete-account-phrase').textContent};
el('next-delete-account').onclick=()=>{if(el('delete-account-input').value!==el('delete-account-phrase').textContent)return;el('delete-account-step-one').classList.add('hidden');el('delete-account-step-two').classList.remove('hidden');el('delete-account-understood').focus()};
el('back-delete-account').onclick=()=>{el('delete-account-step-two').classList.add('hidden');el('delete-account-step-one').classList.remove('hidden');el('delete-account-input').focus()};
el('delete-account-understood').onchange=()=>{el('confirm-delete-account').disabled=!el('delete-account-understood').checked};
el('confirm-delete-account').onclick=async()=>{
  if(el('delete-account-input').value!==el('delete-account-phrase').textContent||!el('delete-account-understood').checked)return;
  const button=el('confirm-delete-account');button.disabled=true;
  try{
    const {data:{session},error:sessionError}=await db.auth.getSession();
    if(sessionError||!session)throw sessionError||new Error('Sign in again before deleting your account.');
    const response=await fetch('/api/account/delete',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+session.access_token},body:JSON.stringify({phrase:el('delete-account-input').value,confirmed:true})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Account deletion failed.');
    await db.auth.signOut({scope:'local'});location.reload();
  }catch(error){settingsNote('delete-account-error',errorMessage(error),true);button.disabled=false}
};
`;
