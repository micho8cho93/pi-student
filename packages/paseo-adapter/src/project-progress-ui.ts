const MARKER = 'data-pi-student-project-progress="v1"';

export const projectProgressUiScript = (port: number) => `
<script ${MARKER}>
(() => {
  const endpoint = "http://127.0.0.1:${port}";
  const workspaceId = () => location.pathname.match(/\\/workspace\\/(wks_[A-Za-z0-9_-]+)/)?.[1];
  const activeAgent = () => [...document.querySelectorAll('[data-pi-student-agent-id]')]
    .find(node => node.getClientRects().length > 0)?.getAttribute('data-pi-student-agent-id');
  const node = (tag, className, label) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (label !== undefined) value.textContent = label;
    return value;
  };
  // One live StudentWorkspaceSnapshot per workspace + Chat. With a revision the bridge answers when something changes.
  const request = async (workspace, agent, since) => {
    const url = new URL(endpoint + '/workspace-snapshot');
    url.searchParams.set('workspaceId', workspace);
    if (agent) url.searchParams.set('agentId', agent);
    if (since) { url.searchParams.set('since', since); url.searchParams.set('wait', '15000'); }
    const response = await fetch(url, { headers: { 'X-Pi-Student': 'ecosystem' } });
    if (!response.ok) throw new Error('Project progress is unavailable.');
    const snapshot = await response.json();
    return { revision: snapshot.revision, progress: snapshot.learning?.source === 'default' ? null : snapshot.learning,
      actions: snapshot.actions, fallback: snapshot.fallback, activeFile: snapshot.activity?.activeFile, managed: snapshot.scope?.managed };
  };
  const stageLabels = [
    ['understand', 'Understand project'], ['plan', 'Plan change'],
    ['implement', 'Implement'], ['verify', 'Test'], ['review', 'Review']
  ];
  let lastKey = '', lastData = null, loading = false, advanced = false, following = '';
  const technicalControls = () => {
    const hide = lastData?.managed && !advanced;
    document.querySelectorAll('[data-pi-student-agent-id] [data-testid="combined-model-selector"], [data-pi-student-agent-id] [data-testid="agent-thinking-selector"], [data-pi-student-agent-id] [data-testid="agent-controls-thinking"]').forEach(control => {
      if (!hide && !control.hasAttribute('data-pi-student-original-display')) return;
      if (!control.hasAttribute('data-pi-student-original-display')) {
        control.setAttribute('data-pi-student-original-display', control.style.getPropertyValue('display'));
        control.setAttribute('data-pi-student-original-priority', control.style.getPropertyPriority('display'));
      }
      control.style.setProperty('display', hide ? 'none' : control.getAttribute('data-pi-student-original-display'),
        hide ? 'important' : control.getAttribute('data-pi-student-original-priority'));
    });
  };
  const render = () => {
    const mount = document.querySelector('#pi-student-project-progress');
    if (!mount || !lastData) return;
    const progress = lastData.progress;
    const actions = lastData.actions || [];
    const available = name => actions.find(item => item.action === name)?.available !== false;
    const current = progress?.stage || 'understand';
    const complete = {
      understand: progress?.understandingReady === true,
      plan: progress?.planApproved === true,
      implement: ['review', 'verify', 'reflect'].includes(current),
      verify: progress?.verificationPassed === true,
      review: ['verify', 'reflect'].includes(current)
    };
    const lines = mount.querySelector('.lines');
    lines.replaceChildren();
    for (const [stage, title] of stageLabels) {
      const marker = complete[stage] ? '✓' : current === stage ? '→' : '○';
      const detail = stage === 'implement' && progress?.activeStep ? ' ' + progress.activeStep : '';
      const row = node('div', complete[stage] ? 'done' : current === stage ? 'current' : 'pending', marker + ' ' + title + detail);
      lines.append(row);
    }
    const next = mount.querySelector('.next');
    next.replaceChildren();
    if (current === 'implement' && !available('agent-edit')) {
      next.append(node('span', '', 'Agent editing unavailable.'));
      const file = lastData.activeFile;
      next.append(node('span', '', file ? 'Open ' + file + ' in Code to continue manually.' : 'Open Code to continue manually.'));
    } else if (lastData.fallback?.headline && !available('ask-guidance')) {
      next.append(node('span', '', lastData.fallback.headline));
      next.append(node('span', '', 'Code and Terminal are still available.'));
    }
    mount.querySelector('.summary').textContent = 'Project progress · ' + (stageLabels.find(item => item[0] === current)?.[1] || 'Review');
    mount.querySelector('.advanced').hidden = !lastData.managed;
    mount.querySelector('.advanced').textContent = advanced ? 'Hide AI settings' : 'Advanced AI settings';
    technicalControls();
  };
  const mount = () => {
    const workspace = workspaceId();
    const anchor = document.querySelector('[data-testid="workspace-tabs-row"]');
    const old = document.querySelector('#pi-student-project-progress');
    if (!workspace || !anchor) { old?.remove(); lastKey = ''; return; }
    if (old && old.previousElementSibling === anchor) return;
    old?.remove();
    const root = node('div'); root.id = 'pi-student-project-progress';
    root.innerHTML = '<style>#pi-student-project-progress{flex:none;padding:5px 14px;border-bottom:1px solid rgba(127,127,127,.18);color:inherit;font:12px system-ui;position:relative;z-index:3}#pi-student-project-progress details{width:max-content;max-width:100%}#pi-student-project-progress summary{cursor:pointer;list-style:none;opacity:.85}#pi-student-project-progress summary::-webkit-details-marker{display:none}#pi-student-project-progress summary:focus-visible,#pi-student-project-progress button:focus-visible{outline:2px solid currentColor;outline-offset:3px}#pi-student-project-progress .body{position:absolute;top:100%;left:10px;width:min(330px,calc(100vw - 35px));padding:12px 14px;border:1px solid rgba(127,127,127,.3);border-radius:9px;background:var(--page-background,#24282b);box-shadow:0 10px 25px #0005;color:inherit;display:grid;gap:10px}#pi-student-project-progress .lines{display:grid;gap:5px}#pi-student-project-progress .done{opacity:.7}#pi-student-project-progress .pending{opacity:.5}#pi-student-project-progress .current{font-weight:650}#pi-student-project-progress .next{display:grid;gap:3px;line-height:1.35}#pi-student-project-progress .tools{border-top:1px solid rgba(127,127,127,.2);padding-top:6px}#pi-student-project-progress button{border:0;background:none;color:inherit;font:inherit;text-align:left;padding:3px 0;cursor:pointer}</style><details><summary class="summary">Project progress</summary><div class="body"><div class="lines"></div><div class="next"></div><button type="button" class="question">Question</button><button type="button" class="advanced" hidden>Advanced AI settings</button><div class="tools" id="pi-student-progress-tools"></div></div></details>';
    anchor.insertAdjacentElement('afterend', root);
    root.querySelector('.advanced').addEventListener('click', () => { advanced = !advanced; render(); });
    root.querySelector('.question').addEventListener('click', () => {
      const composer = [...document.querySelectorAll('[data-pi-student-agent-id] [data-testid="message-input-root"]')].find(item => item.getClientRects().length > 0);
      const input = composer?.querySelector('textarea, [contenteditable="true"]');
      if (!input) { window.alert('Type /question in Chat to practice the current project.'); return; }
      input.focus();
      if (input instanceof HTMLTextAreaElement) {
        if (input.value.trim()) return;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, '/question');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        if (input.textContent?.trim()) return;
        document.execCommand('insertText', false, '/question');
      }
      root.querySelector('details').open = false;
    });
    root.querySelector('details').addEventListener('toggle', () => { if (root.querySelector('details').open) void refresh(); });
    render();
  };
  const current = () => workspaceId() + ':' + (activeAgent() || '');
  const refresh = async () => {
    const workspace = workspaceId();
    if (!workspace || loading) return;
    const agent = activeAgent();
    const key = workspace + ':' + (agent || '');
    loading = true;
    try {
      const data = await request(workspace, agent);
      if (key !== current()) return;
      lastKey = key;
      lastData = data;
      render();
    } catch { /* The workspace remains usable while the bridge starts. */ }
    finally { loading = false; }
  };
  /** Follows the snapshot for one workspace + Chat until either changes; never shows another project's state. */
  const follow = async key => {
    following = key;
    let revision = '';
    while (following === key) {
      const [workspace, agent] = key.split(':');
      try {
        const data = await request(workspace, agent || null, revision);
        if (following !== key || key !== current()) return;
        revision = data.revision;
        lastKey = key;
        lastData = data;
        render();
      } catch { await new Promise(resolve => setTimeout(resolve, 4000)); }
    }
  };
  const tick = () => {
    const key = current();
    if (key !== lastKey) { lastData = null; lastKey = key; }
    mount(); technicalControls();
    if (!workspaceId()) { following = ''; return; }
    if (following !== key) void follow(key);
  };
  const start = () => { tick(); setInterval(tick, 4000); new MutationObserver(mount).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
</script>`;
