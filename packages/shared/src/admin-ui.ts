/** Bright counterpart to the teacher/Paseo GUI's spacing, typography and shell. */
export const adminStyles = `
:root{color-scheme:light;--bg:#f7faf8;--sidebar:#edf5f0;--panel:#fff;--line:#dce7df;--line-soft:#eaf0ec;--text:#20382d;--muted:#60756a;--accent:#18764a;--accent-soft:#d9f1e2;font:14px system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}.hidden{display:none!important}
.app-shell{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100dvh}.sidebar{position:sticky;top:0;height:100dvh;background:var(--sidebar);border-right:1px solid var(--line);padding:20px 14px 16px;display:flex;flex-direction:column;gap:28px}.brand{display:flex;gap:10px;align-items:center;padding:0 9px}.mark{width:32px;height:32px;display:grid;place-items:center;border-radius:8px;background:var(--accent);color:white;font-size:20px;font-weight:700}.brand strong{font-size:14px;font-weight:600}.brand span{display:block;font-size:11px;color:var(--muted);margin-top:3px}.side-label{color:var(--muted);font-size:11px;padding:0 10px 8px}.side-nav{display:grid;gap:4px}.side-link{display:flex;align-items:center;gap:10px;text-decoration:none;text-align:left;border-color:transparent;background:transparent;color:var(--muted);width:100%;font-size:13px}.side-link.active{background:var(--accent-soft);color:#125b39;border-color:#c2e5cf;font-weight:600}.side-icon{width:18px;height:18px;flex:none}.sidebar-note{margin-top:auto;padding:16px 9px 0;border-top:1px solid var(--line);font-size:11px;line-height:1.6;color:var(--muted)}.workspace{min-width:0}.topbar{position:sticky;top:0;z-index:5;height:49px;padding:0 32px;background:var(--panel);border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px}.breadcrumbs{display:flex;gap:10px;font-size:12px;color:var(--muted);min-width:0}.breadcrumbs strong{font-weight:500;color:var(--text)}main{max-width:1360px;margin:auto;padding:32px 32px 58px}.eyebrow{font-size:12px;color:var(--accent);font-weight:600;margin-bottom:8px}h1{font-size:26px;letter-spacing:-.025em;margin:0 0 8px;overflow-wrap:anywhere}h2{font-size:16px;letter-spacing:-.015em;margin:26px 0 12px}h2:first-child{margin-top:0}p{color:var(--muted);line-height:1.6;margin:6px 0 18px}.page-head{margin-bottom:24px}.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:22px;margin:18px 0;min-width:0;box-shadow:0 3px 12px #20382d03}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.space{justify-content:space-between}
button,input,select,textarea{font:inherit;border:1px solid var(--line);border-radius:6px;padding:9px 12px;background:var(--panel);color:var(--text);max-width:100%;min-width:0}button{cursor:pointer;font-size:13px;min-height:36px;font-weight:500;transition:background .15s,border-color .15s}button:hover,.side-link:hover{background:#eaf4ed;border-color:#b5cebe}button.primary{background:var(--accent);border-color:var(--accent);color:white}button.primary:hover{background:#125e3b}button.danger{color:#b02e45}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,a:focus-visible,.table-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.ghost{background:transparent;border-color:transparent;color:var(--muted)}input::placeholder,textarea::placeholder{color:#718378}input[type=checkbox]{accent-color:var(--accent);width:18px;height:18px;cursor:pointer}textarea{width:100%;min-height:140px;font:12px ui-monospace,monospace;line-height:1.6;resize:vertical}label{display:grid;gap:7px;font-size:12px;color:var(--muted);min-width:0}form{margin:18px 0;display:grid;gap:14px}form.row{align-items:flex-end}.row>label{flex:1 1 180px}.row>input{flex:1 1 220px}.row>select{max-width:320px}
.table-scroll{overflow:auto;border:1px solid var(--line);border-radius:8px;margin:18px 0;max-width:100%}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:13px 14px;border-bottom:1px solid var(--line-soft);vertical-align:middle}th{font-size:12px;font-weight:500;background:#f4f8f5;color:var(--muted);white-space:nowrap}td{min-width:100px;max-width:360px;overflow-wrap:anywhere}td:first-child{font-weight:500}tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:#f7fbf8}td button{white-space:nowrap;margin:2px}.muted{color:var(--muted)}.mono{font:12px ui-monospace,SFMono-Regular,monospace}.pill{display:inline-flex;border:1px solid #c2e5cf;border-radius:99px;background:#e4f6eb;color:#17603b;padding:4px 9px;font-size:11px}.pill.off{background:#fff0f0;color:#a42c40;border-color:#f1cbd0}.stat{display:inline-flex;flex-direction:column;gap:7px;background:#f0f8f3;border:1px solid #d9ebdf;border-radius:8px;padding:18px 20px;margin:0 10px 12px 0;min-width:155px;color:var(--muted);font-size:12px}.stat strong{font-size:26px;letter-spacing:-.03em;color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}.notice{padding:14px 16px;border:1px solid #bce2cb;border-radius:8px;background:#eaf8ef;margin:18px 0;line-height:1.5;overflow-wrap:anywhere}.notice.error{background:#fff1f2;border-color:#efc4cb;color:#a32940}#auth{max-width:460px;margin:10vh auto;padding:32px;box-shadow:0 16px 48px #204b3010}#auth h1{margin-top:12px}#auth form{display:grid}#auth button{min-height:42px}#back{margin-bottom:20px}#org-meta{overflow-wrap:anywhere}.empty-state{text-align:center;padding:32px;color:var(--muted)}
.admin-dialog{width:min(520px,calc(100% - 32px));max-height:calc(100dvh - 32px);overflow:auto;border:1px solid var(--line);border-radius:12px;padding:24px;background:var(--panel);color:var(--text);box-shadow:0 24px 70px #20382d38}.admin-dialog::backdrop{background:#102a1b88}.admin-dialog h2{margin:0 0 8px;font-size:20px}.admin-dialog form{margin-bottom:0}.admin-dialog label input:not([type=checkbox]),.admin-dialog label select{width:100%}.admin-dialog .check-field{display:flex;align-items:center;gap:10px;color:var(--text);font-size:13px}.admin-dialog .check-field input{flex:none}.admin-dialog .dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:10px}.admin-dialog .dialog-error{color:#a32940;margin:0}.admin-dialog .dialog-error:empty{display:none}
@media(max-width:1000px){.app-shell{grid-template-columns:210px minmax(0,1fr)}main{padding:26px 22px 48px}.topbar{padding:0 22px}}
@media(max-width:720px){.app-shell{display:block}.sidebar{position:static;height:auto;padding:16px;gap:16px;border-right:0;border-bottom:1px solid var(--line)}.sidebar-note,.side-label{display:none}.side-nav{display:flex;overflow:auto;padding-bottom:4px}.side-link{width:auto;flex:none;white-space:nowrap;min-height:42px}.topbar{position:static;padding:12px 16px;min-height:49px;height:auto}.breadcrumbs{flex-wrap:wrap;gap:6px}main{padding:24px 16px 40px}.card{padding:16px}.page-head{align-items:stretch;flex-direction:column}.page-head select{width:100%;max-width:none}.stat{min-width:calc(50% - 12px);padding:14px;margin-right:8px}.stat strong{font-size:23px}#auth{margin:5vh auto;padding:24px}.row>label{flex-basis:100%}.row>button{min-height:42px}h1{font-size:24px}}
`;

const icons: Record<string, string> = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>',
  classes: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zM13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2"/>',
  models: '<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  policies: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6"/>',
  usage: '<path d="M4 3v18h17M8 17v-5M13 17V8M18 17V4"/>',
  budgets: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18M16 14h2"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
};
export function adminIcon(name: string): string {
  return `<svg class="side-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[name] ?? icons.overview}</svg>`;
}

/** Wrap dynamic tables without replacing their nodes or event listeners. */
export const adminTableScript = `
function styleTables(){document.querySelectorAll('main table').forEach(table=>{if(table.parentElement.classList.contains('table-scroll'))return;const wrap=document.createElement('div');wrap.className='table-scroll';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Scrollable data table');table.before(wrap);wrap.append(table);const body=table.tBodies[0];if(body&&!body.rows.length){const cell=body.insertRow().insertCell();cell.colSpan=table.tHead?.rows[0]?.cells.length||1;cell.className='empty-state';cell.textContent='No records to show yet.'}})}
new MutationObserver(styleTables).observe(document.querySelector('main'),{childList:true,subtree:true});styleTables();
`;

/** An app-owned form dialog for the administration pages, including inline errors. */
export const adminFormScript = `
function openAdminForm({title,description='',fields,submitLabel='Save',onSubmit}){
  const dialog=document.createElement('dialog');dialog.className='admin-dialog';
  const heading=document.createElement('h2');heading.textContent=title;dialog.append(heading);
  if(description){const help=document.createElement('p');help.textContent=description;dialog.append(help)}
  const form=document.createElement('form');dialog.append(form);
  const controls={};
  for(const field of fields){
    const label=document.createElement('label');label.textContent=field.label;
    const control=field.options?document.createElement('select'):document.createElement('input');
    if(field.options){for(const option of field.options){const item=document.createElement('option');item.value=option.value;item.textContent=option.label;control.append(item)}}
    else control.type=field.type||'text';
    control.name=field.name;control.required=!!field.required;
    if(field.min!==undefined)control.min=String(field.min);
    if(field.step!==undefined)control.step=String(field.step);
    if(field.placeholder)control.placeholder=field.placeholder;
    if(control.type==='checkbox'){control.checked=!!field.value;label.className='check-field';label.prepend(control)}
    else{control.value=field.value==null?'':String(field.value);label.append(control)}
    form.append(label);controls[field.name]=control;
  }
  const error=document.createElement('p');error.className='dialog-error';error.setAttribute('role','alert');form.append(error);
  const actions=document.createElement('div');actions.className='dialog-actions';
  const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';
  const save=document.createElement('button');save.type='submit';save.className='primary';save.textContent=submitLabel;
  actions.append(cancel,save);form.append(actions);
  cancel.onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove());
  form.oninput=()=>{error.textContent=''};
  form.onsubmit=async event=>{
    event.preventDefault();if(!form.reportValidity())return;
    const values={};for(const [name,control] of Object.entries(controls))values[name]=control.type==='checkbox'?control.checked:control.value.trim();
    save.disabled=true;cancel.disabled=true;save.textContent='Saving…';
    try{await onSubmit(values);dialog.close()}catch(cause){error.textContent=cause.message||String(cause)}
    finally{save.disabled=false;cancel.disabled=false;save.textContent=submitLabel}
  };
  document.body.append(dialog);dialog.showModal();
  const first=Object.values(controls)[0];if(first)first.focus();
}
`;
