export const dashboardStyles = `
/* Values from Paseo 0.8's default dark theme and shared UI scale.
 * The vendor ships compiled React Native components; these HTML primitives
 * use the same surface, typography, spacing, and control conventions. */
:root {
  color-scheme: dark;
  --bg: #181B1A;
  --sidebar: #141716;
  --panel: #1E2120;
  --panel-strong: #272A29;
  --panel-soft: #181B1A;
  --line: #2F3534;
  --line-soft: #252B2A;
  --text: #fafafa;
  --muted: #A1A5A4;
  --muted-strong: #d4d4d8;
  --accent: #20744A;
  --accent-strong: #7ccba0;
  --violet: #b07ad0;
  --warning: #d4a44a;
  --danger: #e07070;
  --success: #7ccba0;
  --radius: 8px;
  --font-mono: SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
:root[data-theme=light] {
  color-scheme: light;
  --bg:#f6f8f7;--sidebar:#edf1ee;--panel:#fff;--panel-strong:#e9eeeb;--panel-soft:#f8faf8;
  --line:#cbd5ce;--line-soft:#e0e7e2;--text:#18231c;--muted:#596a60;--muted-strong:#34493b;
  --accent:#20744a;--accent-strong:#176b41;--violet:#72448b;--warning:#8b6217;--danger:#ae3434;--success:#176b41;
}
:root[data-density=compact] .content{padding-top:20px}
:root[data-density=compact] .data-table td{padding-top:8px;padding-bottom:8px}
:root[data-density=compact] .panel{padding:14px}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--text);min-height:100vh}
button,input,select,textarea{font:inherit}
button{cursor:pointer}
.hidden{display:none!important}
.app-shell{display:grid;grid-template-columns:260px minmax(0,1fr);min-height:100vh}
.sidebar{background:var(--sidebar);border-right:1px solid var(--line-soft);padding:20px 14px 16px;display:flex;flex-direction:column;gap:22px}
.brand{display:flex;gap:10px;align-items:center;padding:0 9px}
.mark{height:30px;width:30px;border-radius:8px;background:var(--panel-strong);color:var(--text);display:grid;place-items:center;font-weight:900;font-size:16px;box-shadow:none}
.brand strong{font-size:14px;letter-spacing:-.01em}
.brand span{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.side-nav{display:grid;gap:4px}
.side-label{color:var(--muted);font-size:10px;letter-spacing:0;font-weight:600;padding:0 10px 5px}
.side-link{display:flex;align-items:center;gap:9px;color:var(--muted-strong);background:transparent;border:1px solid transparent;border-radius:6px;padding:9px 10px;text-align:left;font-size:13px}
.side-link:hover,.side-link.active{background:var(--panel-strong);border-color:var(--line);color:var(--text)}
.side-link.active{box-shadow:none}
.side-icon{width:18px;color:var(--muted);text-align:center;font-size:14px}
.sidebar-note{margin-top:auto;border-top:1px solid var(--line-soft);padding:14px 9px 0;color:var(--muted);font-size:11px;line-height:1.55}
.workspace{min-width:0}
.topbar{height:48px;border-bottom:1px solid var(--line-soft);display:flex;align-items:center;justify-content:space-between;padding:0 32px;background:var(--bg);backdrop-filter:blur(16px);position:sticky;top:0;z-index:5}
.breadcrumbs{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:12px}
.breadcrumbs strong{color:var(--text);font-weight:500}
.crumb-sep{color:var(--muted)}
.top-actions{display:flex;align-items:center;gap:10px}
.user-email{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:12px}
.content{max-width:1360px;margin:0 auto;padding:32px 32px 58px}
.eyebrow{color:var(--muted);font-size:12px;letter-spacing:0;font-weight:600}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:26px}
.page-head h1{font-size:26px;letter-spacing:-.02em;margin:6px 0 7px}
.page-head p{color:var(--muted);font-size:14px;margin:0;max-width:620px}
.btn{border:1px solid var(--line);border-radius:6px;background:var(--panel-strong);color:var(--text);padding:9px 13px;font-weight:500;font-size:13px;line-height:1.15;transition:border-color .15s,background .15s,transform .15s}
.btn:hover{border-color:var(--muted);background:var(--panel-strong)}
.btn:focus-visible,.field:focus-visible,.select:focus-visible,.tab:focus-visible{outline:2px solid var(--accent-strong);outline-offset:2px}
.btn.primary{background:var(--text);border-color:var(--text);color:var(--bg)}
.btn.primary:hover{background:var(--muted-strong);border-color:var(--muted-strong)}
.btn.ghost{background:transparent;border-color:transparent;color:var(--muted-strong)}
.btn.ghost:hover{background:var(--panel-strong);border-color:var(--line);color:var(--text)}
.btn.danger{color:var(--danger)}
.btn.small{font-size:11px;padding:6px 9px}
.btn.icon-btn{font-size:16px;width:32px;height:32px;padding:0;display:grid;place-items:center}
.field,.select{width:100%;border:1px solid var(--line);background:var(--panel-strong);color:var(--text);border-radius:6px;padding:9px 11px;outline:none}
.field::placeholder{color:var(--muted)}
.select{appearance:auto}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
.toolbar-tools{display:flex;align-items:center;gap:8px}
.search{width:230px}
.table-shell{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);overflow:auto}
.table-shell table{min-width:720px}
.data-table{width:100%;border-collapse:collapse;font-size:13px}
.data-table th{text-align:left;color:var(--muted);font-size:10px;letter-spacing:0;font-weight:600;padding:11px 14px;border-bottom:1px solid var(--line);background:var(--panel-soft);white-space:nowrap}
.data-table td{padding:13px 14px;border-bottom:1px solid var(--line-soft);vertical-align:middle;color:var(--muted-strong)}
.data-table tr:last-child td{border-bottom:0}
.data-table tbody tr:hover{background:rgba(124,203,160,.035)}
.data-table tbody tr[onclick]{cursor:pointer}
.data-table .primary-cell{color:var(--text);font-weight:500}
.data-table .numeric{text-align:right;font-variant-numeric:tabular-nums;color:var(--text)}
.data-table .action-cell{text-align:right;white-space:nowrap}
.empty-cell{padding:38px!important;text-align:center;color:var(--muted)!important}
.badge{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);border-radius:999px;padding:4px 8px;color:var(--muted-strong);font-size:11px;line-height:1;white-space:nowrap}
.badge.accent{background:rgba(124,203,160,.1);border-color:rgba(124,203,160,.28);color:var(--accent-strong)}
.badge.violet{background:rgba(155,140,255,.1);border-color:rgba(155,140,255,.26);color:#c6bdff}
.badge.warning{background:rgba(242,198,109,.1);border-color:rgba(242,198,109,.28);color:var(--warning)}
.badge.danger{background:rgba(242,139,130,.1);border-color:rgba(242,139,130,.28);color:var(--danger)}
.badge.success{background:rgba(137,221,160,.1);border-color:rgba(137,221,160,.28);color:var(--success)}
.muted{color:var(--muted)}
.mono{font-variant-numeric:tabular-nums;font-family:var(--font-mono)}
.metric-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);margin-bottom:16px}
.metric-item{padding:16px 18px;border-right:1px solid var(--line-soft)}
.metric-item:last-child{border-right:0}
.metric-value{font-size:23px;letter-spacing:-.02em;color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.metric-label{font-size:11px;color:var(--muted);margin-top:4px}
.metric-note{font-size:11px;color:var(--muted);margin-top:2px}
.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);padding:18px}
.panel-head{flex-wrap:wrap;display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.panel-head h2,.panel-head h3{font-size:15px;margin:0;color:var(--text);letter-spacing:-.015em}
.panel-head p{margin:5px 0 0;color:var(--muted);font-size:12px}
.overview-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,.85fr);gap:16px;margin-bottom:16px}
.chart-wrap{min-height:244px}
.chart{width:100%;height:224px;display:block;overflow:visible}
.chart-grid{stroke:var(--line);stroke-width:1}
.chart-line{fill:none;stroke:var(--accent-strong);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.chart-area{fill:url(#tokenGradient);opacity:.33}
.chart-dot{fill:var(--panel);stroke:var(--accent-strong);stroke-width:2}
.chart-label{fill:var(--muted);font-size:10px}
.legend{display:flex;gap:14px;align-items:center;color:var(--muted);font-size:11px;margin-top:2px}
.legend-dot{height:7px;width:7px;border-radius:50%;background:var(--accent);display:inline-block}
.signal-list{display:grid;gap:10px}
.signal{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid var(--line-soft)}
.signal:last-child{border-bottom:0;padding-bottom:0}
.signal-dot{height:7px;width:7px;border-radius:50%;margin-top:4px;background:var(--warning);flex:none}
.signal-dot.quiet{background:var(--muted)}
.signal strong{font-size:12px;color:var(--text);font-weight:500}
.signal span{display:block;font-size:11px;line-height:1.45;color:var(--muted);margin-top:2px}
.tabs{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:20px}
.tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);padding:10px 13px 11px;font-size:13px;font-weight:500;margin-bottom:-1px}
.tab:hover{color:var(--muted-strong)}
.tab.active{color:var(--text);border-bottom-color:var(--accent)}
.class-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:20px}
.class-title{display:flex;align-items:flex-start;gap:12px}
.class-title h1{margin:3px 0 7px;font-size:25px;letter-spacing:-.02em}
.class-title p{margin:0;color:var(--muted);font-size:12px}
.class-head-actions{flex-wrap:wrap;display:flex;align-items:center;gap:8px}
.join-code{font-family:var(--font-mono);font-size:12px;color:var(--accent-strong);background:rgba(124,203,160,.08);border:1px solid rgba(124,203,160,.24);border-radius:6px;padding:6px 8px}
.back-link{margin-bottom:12px}
.row{display:flex;align-items:center;gap:8px}
.stack{display:grid;gap:12px}
.notice{padding:12px 13px;border:1px solid var(--line);border-radius:8px;color:var(--muted);font-size:12px;background:var(--panel)}
.notice.error{border-color:var(--danger);color:var(--danger)}
.auth-wrap{max-width:520px;margin:12vh auto;padding:0 22px}
.auth{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:28px;box-shadow:0 24px 80px rgba(0,0,0,.28)}
.auth h1{font-size:26px;margin:6px 0 8px;letter-spacing:-.03em}
.auth p{color:var(--muted);font-size:13px;line-height:1.55;margin:0 0 20px}
.auth .btn{width:100%;margin-top:9px}
.divider{text-align:center;color:var(--muted);font-size:11px;margin:14px 0}
.label{display:grid;gap:6px;color:var(--muted-strong);font-size:12px}
.form-grid{display:grid;gap:13px}
.dialog{max-height:calc(100dvh - 32px);overflow:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);padding:22px;width:min(860px,calc(100% - 28px));box-shadow:0 30px 100px rgba(0,0,0,.45)}
.dialog.small-dialog{width:min(460px,calc(100% - 28px))}
.dialog::backdrop{background:rgba(3,6,10,.78);backdrop-filter:blur(3px)}
.dialog h2{font-size:18px;margin:0 0 6px;letter-spacing:-.02em}
.dialog-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px}
.dialog-subtitle{font-size:12px;color:var(--muted);margin:0}
.dialog-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.student-summary{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line-soft);border-radius:8px;margin-bottom:16px}
.student-summary .metric-item{padding:12px 14px}
.student-summary .metric-value{font-size:18px}
.student-table{max-height:55vh;overflow:auto}
.detail-row{background:rgba(124,203,160,.035)}
.detail-row td{padding-top:0!important}
.detail-copy{padding:10px 0 4px;color:var(--muted);font-size:12px;line-height:1.6;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 20px}
.detail-copy strong{color:var(--muted-strong);font-weight:500}
.dialog-tabs{display:flex;gap:6px;margin-bottom:14px}
.dialog-tab{border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--muted);padding:6px 9px;font-size:11px}
.dialog-tab.active{background:var(--panel-strong);color:var(--text);border-color:var(--muted)}
.table-caption{font-size:11px;color:var(--muted);margin:0 0 9px}
.project-actions{display:flex;gap:6px;justify-content:flex-end}
.requirements{display:flex;flex-wrap:wrap;gap:4px}
.requirements .badge{font-size:10px}
.empty-state{padding:50px 24px;text-align:center}
.empty-state h3{margin:0 0 6px;font-size:15px}
.empty-state p{margin:0;color:var(--muted);font-size:12px}
.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
.settings-panel{min-width:0}
.settings-panel.full{grid-column:1/-1}
.settings-panel h2{font-size:16px;margin:0 0 6px}
.settings-panel>p{color:var(--muted);font-size:12px;line-height:1.55;margin:0 0 18px}
.settings-panel .form-grid{max-width:440px}
.settings-note{min-height:17px;font-size:12px;color:var(--success);margin-top:8px}
.settings-note.error{color:var(--danger)}
.check-field{display:flex;align-items:flex-start;gap:9px;color:var(--muted-strong);font-size:12px;line-height:1.4}
.check-field input{margin:2px 0 0;accent-color:var(--accent-strong)}
.settings-classes{display:grid;gap:10px}
.settings-class-row{display:flex;align-items:end;gap:14px;border:1px solid var(--line-soft);border-radius:8px;padding:12px}
.settings-class-row .label{flex:1;max-width:420px}
.settings-class-row .check-field{padding-bottom:9px;white-space:nowrap}
.settings-class-row .settings-note{min-width:55px;margin:0 0 8px}
.danger-panel{border-color:color-mix(in srgb,var(--danger) 36%,var(--line))}
.confirmation-phrase{display:block;color:var(--text);font-size:13px;word-break:break-word;margin:0 0 14px}
.section-controls{display:flex;flex-wrap:wrap;gap:12px;margin:-8px 0 20px}
.section-controls .label{min-width:min(220px,100%);flex:1 1 220px}
.section-controls .select{width:100%}
.extension-list{display:grid;gap:0}
.extension-row{display:flex;align-items:center;justify-content:space-between;gap:20px;border-top:1px solid var(--line-soft);padding:14px 2px;color:var(--text);font-size:13px}
.extension-row:first-child{border-top:0}
.extension-row strong,.extension-row small{display:block}
.extension-row strong{font-weight:600}
.extension-row small{color:var(--muted);line-height:1.45;margin-top:4px}
.extension-row input{width:18px;height:18px;accent-color:var(--accent-strong);flex:none}
.usage-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));border:1px solid var(--line-soft);border-radius:8px;margin-bottom:16px}
.usage-metrics .metric-item{padding:16px;border-right:1px solid var(--line-soft)}
.usage-metrics .metric-item:last-child{border-right:0}
.usage-limit-form h2{font-size:16px;margin:0 0 6px}
.usage-limit-form>p{font-size:12px;line-height:1.5;margin:0 0 18px}
.limit-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.limit-actions{display:flex;align-items:center;gap:12px;margin-top:18px}
@media(max-width:1000px){.app-shell{grid-template-columns:196px minmax(0,1fr)}
.overview-grid{grid-template-columns:1fr}
.content{padding:26px 22px 50px}
.topbar{padding:0 22px}
}
@media(max-width:720px){.app-shell{display:block}
.sidebar{display:flex;position:static;height:auto;padding:10px 14px;gap:10px}
.sidebar .brand,.sidebar-note,.side-label{display:none}
.side-nav{display:flex;gap:6px}
.side-nav{overflow-x:auto;max-width:100%}
.side-link{padding:7px 10px;white-space:nowrap;flex:none}
.topbar{height:auto;min-height:58px;padding:13px 16px}
.content{padding:22px 14px 42px}
.page-head,.class-head{align-items:stretch;flex-direction:column;gap:15px}
.page-head h1{font-size:25px}
.class-head-actions{justify-content:space-between}
.metric-strip{grid-template-columns:1fr 1fr}
.metric-item:nth-child(2){border-right:0}
.metric-item:nth-child(-n+2){border-bottom:1px solid var(--line-soft)}
.metric-item:nth-child(odd){border-right:1px solid var(--line-soft)}
.toolbar{align-items:stretch;flex-direction:column}
.toolbar-tools{width:100%}
.search{width:100%}
.student-summary{grid-template-columns:1fr 1fr}
.student-summary .metric-item:nth-child(2){border-right:0}
.student-summary .metric-item:nth-child(-n+2){border-bottom:1px solid var(--line-soft)}
.student-summary .metric-item:nth-child(odd){border-right:1px solid var(--line-soft)}
.detail-copy{grid-template-columns:1fr}
.user-email{display:none}
.tabs{overflow:auto}
.tab{white-space:nowrap}
.auth-wrap{margin:8vh auto;padding:0 14px}
.auth{padding:22px}
.chart-wrap{min-height:228px}
.settings-grid{grid-template-columns:1fr}
.settings-panel.full{grid-column:auto}
.settings-class-row{align-items:stretch;flex-direction:column;gap:9px}
.settings-class-row .check-field,.settings-class-row .settings-note{padding:0;margin:0}
.usage-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
.usage-metrics .metric-item:nth-child(even){border-right:0}
.usage-metrics .metric-item{border-bottom:1px solid var(--line-soft)}
}

.builder-dialog{width:min(1040px,calc(100% - 28px))}
.builder-grid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(280px,.9fr);gap:18px}
.builder-chat{min-height:420px;max-height:56vh;overflow:auto;padding:4px}
.chat-message{display:flex;gap:10px;margin:0 0 14px}
.chat-message.teacher{justify-content:flex-end}
.chat-bubble{max-width:86%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel-soft);color:var(--muted-strong);font-size:13px;line-height:1.55;white-space:pre-wrap}
.chat-message.teacher .chat-bubble{background:rgba(124,203,160,.11);border-color:rgba(124,203,160,.25);color:var(--text)}
.chat-author{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.builder-input{display:flex;gap:8px;margin-top:12px}
.builder-input .field{min-height:44px}
.builder-preview{border:1px solid var(--line);border-radius:9px;background:var(--panel-strong);padding:16px;min-height:300px}
.builder-preview h3{margin:0 0 7px;font-size:18px}
.builder-preview p,.builder-preview li{color:var(--muted);font-size:12px;line-height:1.55}
.builder-preview h4{font-size:11px;letter-spacing:0;color:var(--accent);margin:16px 0 6px}
.builder-preview ul{padding-left:18px;margin:6px 0}
.edit-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px}
.edit-grid .full{grid-column:1/-1}
.field.textarea{min-height:86px;resize:vertical}
.dialog-note{color:var(--muted);font-size:12px;line-height:1.5;margin:0 0 14px}
@media(max-width:720px){.builder-grid,.edit-grid{grid-template-columns:1fr}
.edit-grid .full{grid-column:auto}
.builder-chat{max-height:42vh}
}

button:disabled{opacity:.5;cursor:not-allowed}
button:focus-visible,a:focus-visible{outline:2px solid var(--accent-strong);outline-offset:3px}
.panel-head .select{width:auto;max-width:100%}
.sidebar{position:sticky;top:0;height:100dvh}
.brand strong{font-weight:600}
.side-link.active .side-icon{color:var(--text)}
.data-table th{font-size:12px;font-weight:500}
.eyebrow{font-weight:500}
.chart-grid{stroke:var(--line)}
.chart-label{fill:var(--muted)}
.chat-message.teacher .chat-bubble{background:var(--panel-strong);border-color:var(--line)}
.builder-preview{background:var(--bg)}
.field{min-width:0}
.btn{min-height:36px}
.btn.small{min-height:30px}
.btn.icon-btn{min-height:32px}
.dialog-footer{flex-wrap:wrap}
@media(max-width:720px){.panel-head{gap:12px}
.class-head-actions{justify-content:flex-start}
.builder-input{flex-wrap:wrap}
.builder-input .field{flex:1 1 180px}
.dialog-footer .btn{min-height:40px}
.topbar{gap:8px}
.breadcrumbs{min-width:0}
.sidebar{height:auto;position:static;top:auto}
}

`;
