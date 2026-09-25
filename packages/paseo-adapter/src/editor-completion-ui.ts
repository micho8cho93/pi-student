const MARKER = 'data-pi-student-editor-completion="v1"';

/** Runs before Paseo's web bundle and receives each mounted CodeMirror view. */
export const editorCompletionUiScript = (port: number) => `
<script ${MARKER}>
(() => {
  const endpoint = "http://127.0.0.1:${port}";
  const storageKey = "pi-student:editor-completion";
  const keywords = {
    js: "const let var function return async await import export from class extends if else for while try catch throw new true false null undefined",
    ts: "const let var function return async await import export from class interface type extends implements if else for while try catch throw new true false null undefined",
    py: "def class return import from as if elif else for while try except raise with async await True False None self",
    go: "func package import var const type struct interface if else for range return error nil true false defer go",
    rs: "fn let mut pub use mod impl struct enum trait if else match for while loop return Some None Ok Err",
    html: "html head body main section article div span button form input label script style link meta",
    css: "display position color background padding margin border width height flex grid align-items justify-content",
    json: "true false null"
  };
  const workspace = () => {
    const id = location.pathname.split("/workspace/")[1]?.split("/")[0];
    return id && /^wks_[A-Za-z0-9_-]+$/.test(id) ? id : null;
  };
  const read = () => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) || "{}"); return { enabled: value.enabled === true, model: typeof value.model === "string" ? value.model : "auto", perMinute: [2, 5, 10].includes(value.perMinute) ? value.perMinute : 5 }; }
    catch { return { enabled: false, model: "auto", perMinute: 5 }; }
  };
  const save = value => localStorage.setItem(storageKey, JSON.stringify(value));
  const request = async (route, options = {}) => {
    const id = workspace();
    if (!id) throw new Error("Choose a workspace first.");
    const response = await fetch(endpoint + route + "?workspaceId=" + encodeURIComponent(id), {
      ...options, headers: { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" }
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Code completion is unavailable.");
    return body;
  };
  const node = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item; };
  const style = (item, values) => Object.assign(item.style, values);
  window.piStudentFileEditor = (view, filename) => {
    const host = view.dom.parentElement;
    const initialWorkspace = workspace();
    if (!host || !initialWorkspace) return;
    const settings = read();
    let models = [];
    let timer = null;
    let controller = null;
    let revision = 0;
    let popup = null;
    let options = [];
    let selected = 0;
    let ai = null;
    const recent = [];
    const toolbar = node("div");
    const toggle = node("button");
    const panel = node("div");
    const enabled = node("input"); enabled.type = "checkbox"; enabled.checked = settings.enabled;
    const enableLabel = node("label", " AI suggestions"); enableLabel.prepend(enabled);
    const modelLabel = node("label", "Model ");
    const select = node("select"); modelLabel.append(select);
    const limitLabel = node("label", "Requests per minute ");
    const limit = node("select");
    for (const value of [2, 5, 10]) { const option = node("option", String(value)); option.value = String(value); limit.append(option); }
    limit.value = String(settings.perMinute); limitLabel.append(limit);
    const note = node("div", "AI suggestions send excerpts of the open file and up to two nearby source files to the selected model. Local word completion stays on this device.");
    const status = node("div", "");
    toggle.type = "button";
    toggle.title = "Code completion settings";
    toggle.setAttribute("aria-label", "Code completion settings");
    panel.hidden = true;
    style(toolbar, { position: "absolute", right: "22px", top: "8px", zIndex: "20", font: "12px system-ui" });
    style(toggle, { border: "1px solid #7777", borderRadius: "6px", padding: "4px 7px", background: "var(--cm-background, #222)", color: "inherit", cursor: "pointer" });
    style(panel, { position: "absolute", top: "30px", right: "0", width: "280px", padding: "12px", background: "#24282b", color: "#fff", border: "1px solid #777", borderRadius: "8px", boxShadow: "0 8px 24px #0005", display: "none", gap: "10px" });
    style(select, { maxWidth: "100%", width: "100%", marginTop: "4px" });
    style(note, { opacity: ".75", lineHeight: "1.4" });
    style(status, { minHeight: "1em", opacity: ".8" });
    panel.append(enableLabel, modelLabel, limitLabel, note, status);
    toolbar.append(toggle, panel);
    const oldPosition = host.style.position;
    host.style.position = "relative";
    host.append(toolbar);
    const label = () => { toggle.textContent = settings.enabled ? "AI: " + (settings.model === "auto" ? "Auto" : (models.find(item => item.id === settings.model)?.label || settings.model).slice(0, 24)) : "Complete · AI off"; };
    label();
    const loadModels = async () => {
      try {
        models = (await request("/editor-completion/models")).models;
        select.replaceChildren();
        const auto = node("option", "Auto (lowest cost approved)"); auto.value = "auto"; select.append(auto);
        for (const model of models) { const option = node("option", model.label + " (" + model.id + ")"); option.value = model.id; select.append(option); }
        if (!models.some(item => item.id === settings.model)) settings.model = "auto";
        select.value = settings.model;
        status.textContent = models.length ? "" : "Connect an approved model to use AI suggestions.";
        save(settings); label();
      } catch (error) { status.textContent = error.message; }
    };
    toggle.onclick = () => { panel.hidden = !panel.hidden; panel.style.display = panel.hidden ? "none" : "grid"; if (!panel.hidden) void loadModels(); };
    enabled.onchange = () => { settings.enabled = enabled.checked; save(settings); label(); if (!settings.enabled) clear(); else schedule(); };
    select.onchange = () => { settings.model = select.value; save(settings); label(); clear(); };
    limit.onchange = () => { settings.perMinute = Number(limit.value); save(settings); };
    const hidePopup = () => { popup?.remove(); popup = null; options = []; ai = null; };
    const clear = () => { revision++; if (timer) clearTimeout(timer); timer = null; controller?.abort(); controller = null; hidePopup(); };
    const place = () => {
      if (!popup) return;
      const coords = view.coordsAtPos(view.state.selection.main.head);
      if (!coords) return;
      style(popup, { left: Math.max(8, Math.min(coords.left, innerWidth - 340)) + "px", top: Math.max(8, Math.min(coords.bottom + 4, innerHeight - 150)) + "px" });
    };
    const show = (items, suggestion) => {
      hidePopup();
      options = items;
      ai = suggestion;
      popup = node("div");
      popup.setAttribute("role", "listbox");
      style(popup, { position: "fixed", zIndex: "9999", maxWidth: "340px", maxHeight: "140px", overflow: "auto", padding: "5px", border: "1px solid #777", borderRadius: "6px", background: "#24282b", color: "white", boxShadow: "0 8px 24px #0007", font: "12px/1.45 monospace", whiteSpace: "pre-wrap" });
      if (ai) {
        popup.textContent = ai + "  ⇥";
        popup.setAttribute("aria-label", "AI suggestion. Press Tab to accept or Escape to dismiss.");
        style(popup, { padding: "0", border: "0", borderRadius: "0", background: "transparent", color: "#9ca3af", boxShadow: "none", pointerEvents: "none", opacity: ".8" });
      } else items.forEach((item, index) => {
        const row = node("div", item);
        style(row, { padding: "3px 7px", borderRadius: "4px", background: index === selected ? "#507ab1" : "transparent", cursor: "pointer" });
        row.onmousedown = event => { event.preventDefault(); accept(index); };
        popup.append(row);
      });
      document.body.append(popup); place();
    };
    const accept = index => {
      const pos = view.state.selection.main.head;
      if (ai) view.dispatch({ changes: { from: pos, insert: ai }, selection: { anchor: pos + ai.length } });
      else if (options[index]) {
        const before = view.state.sliceDoc(Math.max(0, pos - 80), pos);
        const prefix = before.match(/[A-Za-z_$][A-Za-z0-9_$]*$/)?.[0] || "";
        view.dispatch({ changes: { from: pos - prefix.length, to: pos, insert: options[index] }, selection: { anchor: pos - prefix.length + options[index].length } });
      }
      clear(); view.focus();
    };
    const local = explicit => {
      const state = view.state;
      if (!state.selection.main.empty) return;
      const pos = state.selection.main.head;
      const before = state.sliceDoc(Math.max(0, pos - 80), pos);
      const prefix = before.match(/[A-Za-z_$][A-Za-z0-9_$]*$/)?.[0] || "";
      if (prefix.length < (explicit ? 1 : 3)) return;
      const extension = filename.split(".").pop()?.toLowerCase() || "";
      const base = (keywords[extension] || keywords[extension === "tsx" ? "ts" : extension === "jsx" ? "js" : ""] || "").split(" ");
      const words = state.sliceDoc(Math.max(0, pos - 30000), Math.min(state.doc.length, pos + 30000)).match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) || [];
      const matches = [...new Set([...base, ...words])].filter(word => word !== prefix && word.startsWith(prefix)).slice(0, 6);
      if (matches.length) { selected = 0; show(matches, null); }
    };
    const runAI = async (current, content, pos) => {
      if (recent.filter(at => at > Date.now() - 60000).length >= settings.perMinute) { status.textContent = "Request limit reached for this minute."; return; }
      recent.push(Date.now());
      while (recent[0] < Date.now() - 60000) recent.shift();
      controller = new AbortController();
      try {
        const body = await request("/editor-completion", { method: "POST", signal: controller.signal, body: JSON.stringify({ filename, content, cursor: pos, model: settings.model }) });
        if (current !== revision || workspace() !== initialWorkspace || view.state.doc.toString() !== content || view.state.selection.main.head !== pos || !settings.enabled) return;
        if (body.suggestion && !content.slice(pos).startsWith(body.suggestion)) show([], body.suggestion);
        status.textContent = "Server budget: " + body.remainingMinute + " this minute, " + body.remainingDay + " today.";
      } catch (error) { if (error.name !== "AbortError" && current === revision) status.textContent = error.message; }
    };
    const schedule = () => {
      clear();
      if (workspace() !== initialWorkspace || !view.hasFocus) return;
      local(false);
      if (!settings.enabled) return;
      const state = view.state;
      if (!state.selection.main.empty) return;
      const pos = state.selection.main.head;
      const line = state.doc.lineAt(pos);
      if (pos !== line.to || line.text.trim().length < 5 || !/[A-Za-z0-9_)]$/.test(line.text)) return;
      if (state.doc.length > 50000) return;
      const current = revision, content = state.doc.toString();
      timer = setTimeout(() => { if (current === revision) void runAI(current, content, pos); }, 800);
    };
    const onKeyDown = event => {
      if ((event.ctrlKey || event.metaKey) && event.code === "Space") { event.preventDefault(); clear(); local(true); return; }
      if (!popup) return;
      if (event.key === "Escape") { event.preventDefault(); clear(); return; }
      if (ai && event.key === "Tab") { event.preventDefault(); accept(0); return; }
      if (!ai && options.length && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length; show(options, null); return; }
      if (!ai && options.length && event.key === "Enter") { event.preventDefault(); accept(selected); }
    };
    const onInput = () => setTimeout(schedule, 0);
    const onSelection = () => { if (popup && !view.hasFocus) clear(); };
    view.dom.addEventListener("keydown", onKeyDown, true);
    view.dom.addEventListener("input", onInput);
    view.dom.addEventListener("mouseup", schedule);
    view.dom.addEventListener("blur", onSelection, true);
    const onScroll = () => { if (popup) place(); };
    view.scrollDOM.addEventListener("scroll", onScroll);
    return () => {
      clear(); toolbar.remove(); host.style.position = oldPosition;
      view.dom.removeEventListener("keydown", onKeyDown, true);
      view.dom.removeEventListener("input", onInput);
      view.dom.removeEventListener("mouseup", schedule);
      view.dom.removeEventListener("blur", onSelection, true);
      view.scrollDOM.removeEventListener("scroll", onScroll);
    };
  };
})();
</script>`;
