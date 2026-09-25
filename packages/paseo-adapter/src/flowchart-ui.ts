const FLOWCHART_UI_MARKER = 'data-pi-student-flowchart="v1"';

export const flowchartUiScript = (ecosystemPort: number) => `
  <script ${FLOWCHART_UI_MARKER}>
    (() => {
      const api = "http://127.0.0.1:${ecosystemPort}";
      const state = { workspaceId: null, projectName: null, open: false, loading: false, graph: null, error: "", revision: 0, box: null };
      const svgNs = "http://www.w3.org/2000/svg";
      const el = (tag, className, label) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (label !== undefined) node.textContent = label;
        return node;
      };
      const svgEl = (tag, attributes = {}) => {
        const node = document.createElementNS(svgNs, tag);
        Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
        return node;
      };
      const workspaceId = () => location.pathname.match(/\\/workspace\\/(wks_[A-Za-z0-9_-]+)/)?.[1] || null;
      const root = () => document.querySelector("#pi-student-flowchart");
      const showPanel = () => {
        const panel = root();
        if (!panel) return;
        const row = document.querySelector('[data-testid="workspace-tabs-row"]');
        const sidebar = document.querySelector('[data-testid="sidebar-view"]');
        const rect = row?.getBoundingClientRect();
        const left = rect?.left ?? sidebar?.getBoundingClientRect().right ?? 0;
        const top = state.projectName && !state.workspaceId ? 36 : rect?.bottom ?? 72;
        Object.assign(panel.style, { left: left + "px", top: top + "px", width: (window.innerWidth - left) + "px", height: (window.innerHeight - top) + "px", zIndex: state.projectName ? "1001" : "9", display: state.open ? "flex" : "none" });
        const reference = document.querySelector('[data-testid="workspace-header-title"]') || document.querySelector('[data-testid="new-workspace-project-picker-trigger"]') || row;
        if (reference) panel.style.fontFamily = getComputedStyle(reference).fontFamily;
        const tab = document.querySelector('[data-pi-student-flowchart-tab]');
        tab?.setAttribute("aria-selected", String(state.open));
        tab?.classList.toggle("active", state.open);
        if (tab) tab.style.background = state.open ? "rgba(127,127,127,.18)" : "transparent";
      };
      const close = () => {
        state.open = false;
        state.graph = null;
        state.error = "";
        state.loading = false;
        state.revision++;
        state.projectName = null;
        document.querySelector('[data-pi-student-flowchart-tab]')?.remove();
        showPanel();
      };
      const render = () => {
        const panel = root();
        if (!panel) return;
        const content = panel.querySelector(".flow-content");
        content.replaceChildren();
        panel.querySelector(".back").hidden = !state.projectName;
        panel.querySelector(".refresh").disabled = state.loading;
        panel.querySelector(".zoom-controls").hidden = !state.graph;
        panel.querySelector(".flow-title").textContent = state.graph?.title || "Application flowchart";
        panel.querySelector(".flow-summary").textContent = state.graph?.summary || "See how the parts of this project fit together.";
        if (state.loading) {
          const loading = el("div", "loading");
          loading.setAttribute("role", "status");
          loading.setAttribute("aria-live", "polite");
          loading.append(el("div", "spinner"), el("strong", "", "Generating flowchart…"), el("span", "", "Reading up to 100 project files, excluding known secret files"));
          content.appendChild(loading);
          return;
        }
        if (state.error) {
          const error = el("div", "error");
          error.setAttribute("role", "alert");
          error.append(el("strong", "", "Flowchart unavailable"), el("span", "", state.error));
          const retry = el("button", "secondary", "Try again");
          retry.addEventListener("click", generate);
          error.appendChild(retry);
          content.appendChild(error);
          return;
        }
        if (!state.graph) return;
        const canvas = el("div", "canvas");
        const diagram = svgEl("svg", { role: "img", "aria-label": "Read-only application flowchart" });
        diagram.style.width = "100%";
        diagram.style.height = "100%";
        diagram.style.touchAction = "none";
        const defs = svgEl("defs");
        const marker = svgEl("marker", { id: "pi-flow-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: "auto-start-reverse" });
        marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#7d91a2" }));
        defs.appendChild(marker);
        diagram.appendChild(defs);
        drawGraph(diagram, state.graph);
        canvas.appendChild(diagram);
        content.appendChild(canvas);
        const meta = el("div", "meta", state.graph.nodes.length + " steps · Based on " + state.graph.filesRead + " project files" + (state.graph.truncated ? " · Large files were summarized" : "") + (state.graph.model ? " · Model " + state.graph.model : "") + " · Generated " + new Date(state.graph.generatedAt).toLocaleTimeString());
        content.appendChild(meta);
      };
      const wrap = (value, max = 26, maxLines = 3) => {
        const words = String(value || "").trim().split(/\\s+/).filter(Boolean);
        if (!words.length) return [];
        const lines = [];
        let truncated = false;
        for (const word of words) {
          const current = lines.length - 1;
          const safeWord = word.length > max ? word.slice(0, max - 1) + "…" : word;
          if (lines[current] && (lines[current] + " " + safeWord).length > max) {
            if (lines.length === maxLines) { truncated = true; break; }
            lines.push(safeWord);
          } else if (lines[current]) lines[current] += " " + safeWord;
          else lines.push(safeWord);
          if (safeWord.endsWith("…") && safeWord.length < word.length) truncated = true;
        }
        if (truncated && lines.length) {
          const last = lines.length - 1;
          lines[last] = lines[last].replace(/…?$/, "").slice(0, max - 1) + "…";
        }
        return lines;
      };
      const drawGraph = (diagram, graph) => {
        const nodes = graph.nodes;
        const depths = new Map(nodes.map(node => [node.id, 0]));
        for (let pass = 0; pass < nodes.length; pass++) {
          let changed = false;
          graph.edges.forEach(edge => {
            const next = Math.min(nodes.length - 1, (depths.get(edge.from) || 0) + 1);
            if (next > (depths.get(edge.to) || 0)) { depths.set(edge.to, next); changed = true; }
          });
          if (!changed) break;
        }
        const layers = new Map();
        nodes.forEach(node => { const depth = depths.get(node.id) || 0; if (!layers.has(depth)) layers.set(depth, []); layers.get(depth).push(node); });
        const sorted = [...layers.entries()].sort((a, b) => a[0] - b[0]);
        const nodeWidth = 232, nodeHeight = 128, columnGap = 156, rowGap = 76, padX = 64, padY = 62;
        const largestColumn = Math.max(...sorted.map(([, column]) => column.length));
        const columnHeight = largestColumn * nodeHeight + Math.max(0, largestColumn - 1) * rowGap;
        const width = Math.max(700, padX * 2 + sorted.length * nodeWidth + Math.max(0, sorted.length - 1) * columnGap);
        const height = Math.max(460, padY * 2 + columnHeight + 110);
        const positions = new Map();
        sorted.forEach(([, column], columnIndex) => {
          const layerHeight = column.length * nodeHeight + Math.max(0, column.length - 1) * rowGap;
          const top = padY + (columnHeight - layerHeight) / 2;
          column.forEach((node, index) => positions.set(node.id, { x: padX + columnIndex * (nodeWidth + columnGap), y: top + index * (nodeHeight + rowGap) }));
        });
        state.box = { x: 0, y: 0, w: width, h: height };
        const updateBox = () => diagram.setAttribute("viewBox", [state.box.x, state.box.y, state.box.w, state.box.h].join(" "));
        updateBox();
        const incoming = new Set(graph.edges.map(edge => edge.to));
        const outgoing = new Map();
        graph.edges.forEach(edge => outgoing.set(edge.from, (outgoing.get(edge.from) || 0) + 1));
        const nodeRects = nodes.map(node => ({ ...positions.get(node.id), w: nodeWidth, h: nodeHeight }));
        const knownTypes = new Set(["start", "end", "decision", "action", "input", "output", "module", "data"]);
        const types = new Map();
        const inferType = (node, index) => {
          const explicit = String(node.type || "").toLowerCase();
          if (knownTypes.has(explicit)) return explicit;
          const text = (node.label + " " + (node.detail || "")).toLowerCase();
          if (!incoming.has(node.id) && index === 0) return "start";
          if (!outgoing.has(node.id)) return "end";
          if ((outgoing.get(node.id) || 0) > 1 || /\\b(if|whether|decide|decision|valid|allowed|success|failure|choose|check)\\b|\\?$/.test(text)) return "decision";
          if (/\\b(database|storage|store|record|file|cache|table)\\b/.test(text)) return "data";
          if (/\\b(api|service|component|module|server|client|worker|controller)\\b/.test(text)) return "module";
          if (/\\b(input|request|submit|upload|receive|read)\\b/.test(text)) return "input";
          if (/\\b(output|response|result|render|show|display|return)\\b/.test(text)) return "output";
          return "action";
        };
        nodes.forEach((node, index) => types.set(node.id, inferType(node, index)));
        const edgeLabels = [];
        graph.edges.forEach((edge, edgeIndex) => {
          const from = positions.get(edge.from), to = positions.get(edge.to);
          if (!from || !to) return;
          const forward = to.x > from.x;
          let startX, startY, endX, endY, pathData, labelX, labelY;
          if (forward) {
            startX = from.x + nodeWidth; startY = from.y + nodeHeight / 2;
            endX = to.x; endY = to.y + nodeHeight / 2;
            const middle = (startX + endX) / 2;
            pathData = "M " + startX + " " + startY + " C " + middle + " " + startY + ", " + middle + " " + endY + ", " + endX + " " + endY;
            labelX = middle; labelY = (startY + endY) / 2;
          } else {
            startX = from.x + nodeWidth / 2; startY = from.y + nodeHeight;
            endX = to.x + nodeWidth / 2; endY = to.y + nodeHeight;
            const routeY = Math.max(startY, endY) + 34 + (edgeIndex % 3) * 18;
            pathData = "M " + startX + " " + startY + " C " + startX + " " + routeY + ", " + endX + " " + routeY + ", " + endX + " " + endY;
            labelX = (startX + endX) / 2; labelY = routeY;
          }
          const path = svgEl("path", { d: pathData, fill: "none", stroke: "#8199a6", "stroke-width": 2.2, "marker-end": "url(#pi-flow-arrow)" });
          diagram.appendChild(path);
          if (edge.label?.trim()) {
            const lines = wrap(edge.label, Math.max(8, Math.floor((columnGap - 40) / 7.2)), 2);
            const labelWidth = Math.min(columnGap - 20, Math.max(52, Math.max(...lines.map(line => line.length)) * 7.2 + 20));
            const labelHeight = Math.max(24, lines.length * 14 + 8);
            const offsets = [0, -24, 24, -48, 48, -72, 72, -96, 96];
            let box = null;
            for (const offset of offsets) {
              const candidate = { x: labelX - labelWidth / 2, y: labelY + offset - labelHeight / 2, w: labelWidth, h: labelHeight };
              const touchesNode = nodeRects.some(rect => candidate.x < rect.x + rect.w + 6 && candidate.x + candidate.w > rect.x - 6 && candidate.y < rect.y + rect.h + 6 && candidate.y + candidate.h > rect.y - 6);
              const touchesLabel = edgeLabels.some(rect => candidate.x < rect.x + rect.w + 5 && candidate.x + candidate.w > rect.x - 5 && candidate.y < rect.y + rect.h + 5 && candidate.y + candidate.h > rect.y - 5);
              if (!touchesNode && !touchesLabel) { box = candidate; break; }
            }
            if (!box) box = { x: labelX - labelWidth / 2, y: labelY - labelHeight / 2, w: labelWidth, h: labelHeight };
            edgeLabels.push({ box, lines });
          }
        });
        nodes.forEach((node, index) => {
          const position = positions.get(node.id);
          const group = svgEl("g");
          const type = types.get(node.id);
          const palette = {
            start: { fill: "#174d42", stroke: "#59d4ae", text: "#b7f5df" }, end: { fill: "#54343b", stroke: "#ef8d9a", text: "#ffd4d9" },
            decision: { fill: "#584523", stroke: "#f4c15d", text: "#ffe3a2" }, action: { fill: "#263f58", stroke: "#76b5e5", text: "#c9e7ff" },
            input: { fill: "#214b55", stroke: "#6bd2df", text: "#c5f5fa" }, output: { fill: "#214b55", stroke: "#6bd2df", text: "#c5f5fa" },
            module: { fill: "#443c62", stroke: "#b1a0f3", text: "#e3dcff" }, data: { fill: "#3c4b38", stroke: "#a6cf75", text: "#e1f2c8" }
          };
          const color = palette[type] || palette.action;
          if (type === "start" || type === "end") group.appendChild(svgEl("rect", { x: position.x, y: position.y + 5, width: nodeWidth, height: nodeHeight - 10, rx: (nodeHeight - 10) / 2, fill: color.fill, stroke: color.stroke, "stroke-width": 2 }));
          else if (type === "decision") group.appendChild(svgEl("polygon", { points: (position.x + nodeWidth / 2) + "," + position.y + " " + (position.x + nodeWidth) + "," + (position.y + nodeHeight / 2) + " " + (position.x + nodeWidth / 2) + "," + (position.y + nodeHeight) + " " + position.x + "," + (position.y + nodeHeight / 2), fill: color.fill, stroke: color.stroke, "stroke-width": 2 }));
          else if (type === "input" || type === "output") group.appendChild(svgEl("polygon", { points: (position.x + 20) + "," + position.y + " " + (position.x + nodeWidth) + "," + position.y + " " + (position.x + nodeWidth - 20) + "," + (position.y + nodeHeight) + " " + position.x + "," + (position.y + nodeHeight), fill: color.fill, stroke: color.stroke, "stroke-width": 2 }));
          else if (type === "data") {
            group.appendChild(svgEl("path", { d: "M " + position.x + " " + (position.y + 18) + " C " + position.x + " " + (position.y - 4) + ", " + (position.x + nodeWidth) + " " + (position.y - 4) + ", " + (position.x + nodeWidth) + " " + (position.y + 18) + " V " + (position.y + nodeHeight - 18) + " C " + (position.x + nodeWidth) + " " + (position.y + nodeHeight + 4) + ", " + position.x + " " + (position.y + nodeHeight + 4) + ", " + position.x + " " + (position.y + nodeHeight - 18) + " Z", fill: color.fill, stroke: color.stroke, "stroke-width": 2 }));
            group.appendChild(svgEl("path", { d: "M " + position.x + " " + (position.y + 18) + " C " + position.x + " " + (position.y + 40) + ", " + (position.x + nodeWidth) + " " + (position.y + 40) + ", " + (position.x + nodeWidth) + " " + (position.y + 18), fill: "none", stroke: color.stroke, "stroke-width": 1.5 }));
          } else {
            group.appendChild(svgEl("rect", { x: position.x, y: position.y, width: nodeWidth, height: nodeHeight, rx: 14, fill: color.fill, stroke: color.stroke, "stroke-width": 2 }));
            if (type === "module") group.appendChild(svgEl("path", { d: "M " + (position.x + 11) + " " + (position.y + 2) + " V " + (position.y + nodeHeight - 2) + " M " + (position.x + nodeWidth - 11) + " " + (position.y + 2) + " V " + (position.y + nodeHeight - 2), stroke: color.stroke, "stroke-width": 1.5, opacity: ".7" }));
          }
          const title = svgEl("title"); title.textContent = (node.detail ? node.label + ". " + node.detail : node.label) + " — " + type; group.appendChild(title);
          const typeTag = svgEl("text", { x: position.x + nodeWidth / 2, y: position.y + 24, "text-anchor": "middle", "dominant-baseline": "middle", fill: color.text, "font-size": 10, "font-weight": 700, "letter-spacing": 1 });
          typeTag.textContent = type.toUpperCase(); group.appendChild(typeTag);
          const labelLines = wrap(node.label, type === "decision" ? 18 : 25, 2);
          labelLines.forEach((line, lineIndex) => { const text = svgEl("text", { x: position.x + nodeWidth / 2, y: position.y + 59 + (lineIndex - (labelLines.length - 1) / 2) * 17, "text-anchor": "middle", "dominant-baseline": "middle", fill: "#f5f8fb", "font-size": 14, "font-weight": 650 }); text.textContent = line; group.appendChild(text); });
          const detailLines = wrap(node.detail || "", type === "decision" ? 14 : 31, 2);
          detailLines.forEach((line, lineIndex) => { const text = svgEl("text", { x: position.x + nodeWidth / 2, y: position.y + 96 + lineIndex * 14, "text-anchor": "middle", "dominant-baseline": "middle", fill: "#bacbd3", "font-size": 11.5 }); text.textContent = line; group.appendChild(text); });
          diagram.appendChild(group);
        });
        edgeLabels.forEach(({ box, lines }) => {
          const group = svgEl("g");
          group.appendChild(svgEl("rect", { x: box.x, y: box.y, width: box.w, height: box.h, rx: 9, fill: "#11191e", stroke: "#465d68", "stroke-width": 1.4 }));
          lines.forEach((line, lineIndex) => { const text = svgEl("text", { x: box.x + box.w / 2, y: box.y + box.h / 2 + (lineIndex - (lines.length - 1) / 2) * 14, "text-anchor": "middle", "dominant-baseline": "middle", fill: "#e1edf1", "font-size": 11.5, "font-weight": 600 }); text.textContent = line; group.appendChild(text); });
          diagram.appendChild(group);
        });
        let pointer = null;
        diagram.addEventListener("pointerdown", event => { pointer = { x: event.clientX, y: event.clientY, box: { ...state.box } }; diagram.setPointerCapture(event.pointerId); });
        diagram.addEventListener("pointermove", event => {
          if (!pointer) return;
          const rect = diagram.getBoundingClientRect();
          state.box.x = pointer.box.x - (event.clientX - pointer.x) * pointer.box.w / rect.width;
          state.box.y = pointer.box.y - (event.clientY - pointer.y) * pointer.box.h / rect.height;
          updateBox();
        });
        diagram.addEventListener("pointerup", () => { pointer = null; });
        diagram.addEventListener("pointercancel", () => { pointer = null; });
        diagram.addEventListener("wheel", event => {
          event.preventDefault();
          zoom(diagram, event.deltaY < 0 ? 0.85 : 1.15, event.clientX, event.clientY);
        }, { passive: false });
        diagram.piFlowUpdateBox = updateBox;
      };
      const zoom = (diagram, factor, clientX, clientY) => {
        if (!state.box || !diagram) return;
        const rect = diagram.getBoundingClientRect();
        const ratioX = clientX === undefined ? 0.5 : (clientX - rect.left) / rect.width;
        const ratioY = clientY === undefined ? 0.5 : (clientY - rect.top) / rect.height;
        const old = { ...state.box };
        state.box.w = Math.max(220, Math.min(12000, old.w * factor));
        state.box.h = Math.max(160, Math.min(12000, old.h * factor));
        state.box.x = old.x + (old.w - state.box.w) * ratioX;
        state.box.y = old.y + (old.h - state.box.h) * ratioY;
        diagram.piFlowUpdateBox();
      };
      const generate = async () => {
        if ((!state.workspaceId && !state.projectName) || state.loading) return;
        const revision = ++state.revision;
        state.loading = true;
        state.error = "";
        render();
        try {
          const target = state.workspaceId ? "workspaceId=" + encodeURIComponent(state.workspaceId) : "projectName=" + encodeURIComponent(state.projectName);
          const response = await fetch(api + "/flowchart?" + target, { method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" }, body: "{}" });
          const graph = await response.json();
          if (!response.ok) throw new Error(graph.error || "The flowchart could not be generated.");
          if (revision !== state.revision) return;
          state.graph = graph;
        } catch (error) { if (revision === state.revision) state.error = error.message; }
        finally { if (revision === state.revision) { state.loading = false; render(); } }
      };
      const ensurePanel = () => {
        if (root()) return;
        const panel = el("section"); panel.id = "pi-student-flowchart";
        panel.setAttribute("aria-label", "Application flowchart");
        panel.innerHTML = '<style>#pi-student-flowchart{position:fixed;z-index:9;box-sizing:border-box;display:none;flex-direction:column;background:#181b1a;color:#e9f0f2;border-top:1px solid #3e4748;font-size:14px}#pi-student-flowchart *{box-sizing:border-box}#pi-student-flowchart .head{display:flex;align-items:center;gap:16px;padding:17px 24px;border-bottom:1px solid #344044;flex-wrap:wrap}#pi-student-flowchart .heading{flex:1;min-width:230px}#pi-student-flowchart h2{font-size:20px;line-height:1.25;margin:0 0 4px}#pi-student-flowchart .flow-summary{color:#9db0b8;line-height:1.4}#pi-student-flowchart .badge{border:1px solid #567887;border-radius:99px;padding:4px 9px;color:#b7d5e1;font-size:12px}#pi-student-flowchart button{font:inherit;color:inherit;background:#26363b;border:1px solid #5a7179;border-radius:8px;padding:7px 11px;cursor:pointer}#pi-student-flowchart button:hover{background:#34505a}#pi-student-flowchart button:disabled{opacity:.5;cursor:default}#pi-student-flowchart button:focus-visible{outline:2px solid #86d2ec;outline-offset:2px}#pi-student-flowchart .zoom-controls{display:flex;gap:6px}#pi-student-flowchart .flow-content{display:flex;flex:1;min-height:0;flex-direction:column}#pi-student-flowchart .canvas{flex:1;min-height:0;overflow:hidden;background-color:#1c2427;background-image:radial-gradient(#3b515b 1px,transparent 1px);background-size:22px 22px;cursor:grab}#pi-student-flowchart .canvas:active{cursor:grabbing}#pi-student-flowchart .meta{padding:9px 24px;color:#8fa2aa;border-top:1px solid #344044;font-size:12px}#pi-student-flowchart .loading,#pi-student-flowchart .error{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:15px;text-align:center;padding:24px;color:#a9bdc4}#pi-student-flowchart .loading strong,#pi-student-flowchart .error strong{color:#edf5f6;font-size:20px}#pi-student-flowchart .spinner{width:54px;height:54px;border:4px solid #3a525c;border-top-color:#7bd3ef;border-radius:50%;animation:pi-flow-spin .85s linear infinite;box-shadow:0 0 28px #2e718855}@keyframes pi-flow-spin{to{transform:rotate(360deg)}}[data-pi-student-flowchart-tab]{display:inline-flex;align-items:center;gap:8px;flex:none;height:31px;max-width:180px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer}[data-pi-student-flowchart-tab].active{background:rgba(127,127,127,.18)}[data-pi-student-flowchart-tab] .close{font-size:16px;line-height:1;opacity:.6;padding:2px}[data-pi-student-flowchart-tab] .close:hover{opacity:1}</style><div class="head"><button type="button" class="back" hidden>← Back</button><div class="heading"><h2 class="flow-title">Application flowchart</h2><div class="flow-summary">See how the parts of this project fit together.</div></div><span class="badge">Read-only</span><div class="zoom-controls" hidden><button type="button" class="zoom-out" aria-label="Zoom out">−</button><button type="button" class="zoom-in" aria-label="Zoom in">+</button><button type="button" class="fit">Fit</button></div><button type="button" class="refresh">↻ Refresh</button></div><div class="flow-content"></div>';
        document.body.appendChild(panel);
        panel.querySelector(".back").addEventListener("click", close);
        panel.querySelector(".refresh").addEventListener("click", generate);
        panel.querySelector(".zoom-in").addEventListener("click", () => zoom(panel.querySelector("svg"), 0.8));
        panel.querySelector(".zoom-out").addEventListener("click", () => zoom(panel.querySelector("svg"), 1.25));
        panel.querySelector(".fit").addEventListener("click", render);
      };
      const ensureTab = () => {
        const plus = document.querySelector('[data-testid="workspace-new-tab-button"]');
        const row = plus?.parentElement?.parentElement;
        if (!row) return;
        let tab = document.querySelector('[data-pi-student-flowchart-tab]');
        if (tab?.parentElement !== row) { tab?.remove(); tab = null; }
        if (!tab) {
          tab = el("button", "", "◇ Flowchart");
          tab.type = "button";
          tab.dataset.piStudentFlowchartTab = "true";
          tab.setAttribute("aria-label", "Open flowchart tab");
          Object.assign(tab.style, { display: "inline-flex", alignItems: "center", gap: "8px", flex: "none", height: "31px", maxWidth: "180px", padding: "0 9px", border: "0", borderRadius: "7px", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" });
          const dismiss = el("span", "close", "×");
          Object.assign(dismiss.style, { fontSize: "16px", lineHeight: "1", opacity: ".65", padding: "2px" });
          dismiss.setAttribute("role", "button");
          dismiss.setAttribute("aria-label", "Close flowchart tab");
          dismiss.tabIndex = 0;
          dismiss.addEventListener("click", event => { event.stopPropagation(); close(); });
          dismiss.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); close(); } });
          tab.appendChild(dismiss);
          tab.addEventListener("click", () => { state.open = true; showPanel(); });
          row.insertBefore(tab, plus.parentElement);
        }
      };
      const open = () => {
        const id = workspaceId();
        if (!id) return;
        state.revision++;
        state.loading = false;
        state.workspaceId = id;
        state.projectName = null;
        state.open = true;
        state.graph = null;
        ensurePanel();
        ensureTab();
        showPanel();
        generate();
      };
      const openNewWorkspaceFlowchart = () => {
        const selected = document.querySelector('[data-testid="new-workspace-project-picker-trigger"] > div > div[dir="auto"]');
        const name = selected?.textContent?.trim();
        if (!name) { window.alert("Choose a project before generating a flowchart."); return; }
        state.revision++;
        state.loading = false;
        state.workspaceId = null;
        state.projectName = name;
        state.open = true;
        state.graph = null;
        ensurePanel();
        showPanel();
        generate();
      };
      const addMenuChoice = (terminal, label, action = open) => {
        if (terminal.parentElement?.querySelector('[data-pi-student-flowchart-choice]')) return;
        const menu = terminal.closest('[data-menu-surface]');
        const choice = terminal.cloneNode(true);
        choice.removeAttribute("data-testid");
        choice.dataset.piStudentFlowchartChoice = "true";
        const text = choice.querySelector("[dir=auto]");
        if (text) text.textContent = label;
        const last = choice.lastElementChild;
        if (last && last !== text?.parentElement) last.remove();
        choice.addEventListener("click", event => {
          event.preventDefault(); event.stopPropagation();
          action();
          document.querySelector('[aria-label="Menu backdrop"]')?.click();
        });
        terminal.insertAdjacentElement("afterend", choice);
        if (menu?.style.height) menu.style.height = "auto";
      };
      const mount = () => {
        const id = workspaceId();
        if (state.workspaceId && id !== state.workspaceId) { close(); state.workspaceId = null; }
        if (state.projectName && location.pathname !== "/new") close();
        if (id && state.graph && !document.querySelector('[data-pi-student-flowchart-tab]')) ensureTab();
        document.querySelectorAll('[data-testid="workspace-new-tab-menu-terminal"], [data-testid="workspace-header-new-terminal"], [data-testid^="workspace-new-tab-"][data-testid$="terminal"]').forEach(terminal => {
          addMenuChoice(terminal, terminal.getAttribute("data-testid")?.startsWith("workspace-header") ? "New flowchart" : "Flowchart");
        });
        document.querySelectorAll('[data-testid="new-workspace-launch-option-blank"]').forEach(terminal => addMenuChoice(terminal, "Flowchart", openNewWorkspaceFlowchart));
        document.querySelectorAll('[data-testid="workspace-new-tab-menu-agent"], [data-testid="workspace-header-new-agent"]').forEach(agent => {
          const text = agent.querySelector("[dir=auto]") || [...agent.querySelectorAll("*")].find(node => !node.children.length && /^(New )?Agent$/.test(node.textContent.trim()));
          if (text && /^(New )?Agent$/.test(text.textContent.trim())) text.textContent = text.textContent.trim().startsWith("New") ? "New chat" : "Chat";
        });
        showPanel();
      };
      document.addEventListener("click", event => {
        if (event.target.closest?.('[data-testid^="workspace-tab-"]') && !event.target.closest('[data-pi-student-flowchart-tab]')) { state.open = false; showPanel(); }
      }, true);
      window.addEventListener("resize", showPanel);
      window.addEventListener("popstate", mount);
      const start = () => { ensurePanel(); mount(); new MutationObserver(mount).observe(document.body, { childList: true, subtree: true }); };
      if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
    })();
  </script>`;
