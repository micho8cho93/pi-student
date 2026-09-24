import { patchLearnControlsBundle } from "./learn-controls-patch.js";
import { flowchartUiScript } from "./flowchart-ui.js";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STUDENT_UI_MARKER = "data-pi-student-ui=\"student-v12\"";

// Paseo owns the bundled web UI, so keep this small student-specific shell
// override here rather than forking the whole vendor web application.
export const studentUiScript = (ecosystemPort: number) => `
    <script ${STUDENT_UI_MARKER}>
      (() => {
        const settingsKey = "@paseo:app-settings";
        const connectionRegistryKey = "@paseo:daemon-registry";
        const connectionRecoveryKey = "pi-student:connection-recovery";
        const connectionRecoveryPathKey = "pi-student:connection-recovery-path";
        const ecosystemApi = "http://127.0.0.1:${ecosystemPort}";
        let ecosystemState = null;
        let githubSignIn = null;
        let githubConnectPromise = null;
        let ecosystemView = null;
        let githubOpen = false;
        let deploymentsOpen = false;
        let coveredMain = null;
        let coveredMainWasInert = false;
        let refreshTimer = null;
        let pageResizeObserver = null;
        const sidebarList = () => document.querySelector('[data-testid="sidebar-project-workspace-list-scroll"], [data-testid="sidebar-status-list-scroll"]');
        const findMainArea = () => {
          const list = sidebarList();
          if (!list) return null;
          const edge = list.getBoundingClientRect().right;
          for (let branch = list; branch?.parentElement && branch.parentElement !== document.body; branch = branch.parentElement) {
            const main = [...branch.parentElement.children].find(node => {
              const rect = node.getBoundingClientRect();
              return node !== branch && rect.left >= edge && rect.width > 100 && rect.height > 100;
            });
            if (main) return main;
          }
          return null;
        };
        const releaseMainArea = () => {
          if (coveredMain) {
            coveredMain.inert = coveredMainWasInert;
            pageResizeObserver?.unobserve(coveredMain);
          }
          coveredMain = null;
        };
        const closeEcosystemPage = () => {
          ecosystemView = null;
          releaseMainArea();
          document.querySelector("#pi-student-ecosystem-page")?.shadowRoot?.querySelector(".page-root")?.replaceChildren();
        };
        const positionEcosystemPage = () => {
          const mount = document.querySelector("#pi-student-ecosystem-page");
          const page = mount?.shadowRoot?.querySelector(".panel-backdrop");
          if (!page) return;
          const main = findMainArea();
          const rect = main?.getBoundingClientRect();
          const bounds = rect ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
          Object.assign(page.style, { left: bounds.left + "px", top: bounds.top + "px", width: bounds.width + "px", height: bounds.height + "px" });
          const reference = document.querySelector('[data-testid="workspace-header-title"]') || sidebarList()?.querySelector('[dir="auto"]');
          const textStyle = getComputedStyle(reference || main);
          mount.style.fontFamily = textStyle.fontFamily;
          mount.style.color = textStyle.color;
          mount.style.setProperty("--page-primary", textStyle.color);
          for (let node = main; node; node = node.parentElement) {
            const background = getComputedStyle(node).backgroundColor;
            if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
              mount.style.setProperty("--page-background", background);
              break;
            }
          }
          if (main && coveredMain !== main) {
            releaseMainArea();
            coveredMain = main;
            coveredMainWasInert = main.inert;
            main.inert = true;
            pageResizeObserver?.observe(main);
          } else if (!main) releaseMainArea();
        };
        const hiddenTestIds = new Set([
          "sidebar-hosts-trigger",
          "sidebar-import-session",
          "sidebar-schedules",
          "open-project-import-session",
          "workspace-header-import-agent",
          "workspace-header-new-browser",
          "workspace-new-tab-browser"
        ]);
        const hiddenLabels = new Set([
          "Hosts",
          "Import session",
          "Schedules",
          "New browser",
          "Manage profiles",
          "Enable Voice mode",
          "Voice mode",
          "Mute Voice mode",
          "Unmute Voice mode"
        ]);

        const hide = (element) => {
          element.hidden = true;
          element.setAttribute("aria-hidden", "true");
          element.style.setProperty("display", "none", "important");
        };

        const keepWorkVisible = () => {
          try {
            const stored = JSON.parse(localStorage.getItem(settingsKey) || "{}");
            localStorage.setItem(settingsKey, JSON.stringify({
              ...stored,
              autoExpandReasoning: false,
              toolCallDetailLevel: "detailed",
              compactToolCalls: false
            }));
          } catch {
            localStorage.setItem(settingsKey, JSON.stringify({
              autoExpandReasoning: false,
              toolCallDetailLevel: "detailed",
              compactToolCalls: false
            }));
          }
        };

        const installConnectionRecovery = () => {
          let recoveryBoot = false;
          let savedPath = null;
          try {
            recoveryBoot = sessionStorage.getItem(connectionRecoveryKey) === "reset";
            savedPath = sessionStorage.getItem(connectionRecoveryPathKey);
            if (recoveryBoot) {
              // Pi Student is deliberately single-host and local-only. Paseo
              // can otherwise skip its fresh localhost bootstrap when this
              // browser cache contains a matching but stale host record.
              // Projects and conversations live in the daemon; this key only
              // contains browser-side connection metadata.
              localStorage.removeItem(connectionRegistryKey);
              sessionStorage.setItem(connectionRecoveryKey, "restore");
            }
          } catch {}

          const finish = () => {
            if (!sidebarList()) return false;
            try {
              sessionStorage.removeItem(connectionRecoveryKey);
              sessionStorage.removeItem(connectionRecoveryPathKey);
            } catch {}
            if (recoveryBoot && savedPath && savedPath !== location.pathname + location.search + location.hash) {
              location.replace(savedPath);
            }
            return true;
          };
          const observe = () => {
            if (finish()) return;
            const observer = new MutationObserver(() => {
              if (finish()) observer.disconnect();
            });
            observer.observe(document.body, { childList: true, subtree: true });
          };
          if (document.body) observe();
          else document.addEventListener("DOMContentLoaded", observe, { once: true });

          // A healthy local daemon normally mounts the sidebar in a few
          // seconds. Retry once with a fresh connection registry instead of
          // leaving a student on the startup splash indefinitely.
          if (!recoveryBoot) window.setTimeout(() => {
            if (sidebarList()) return;
            try {
              sessionStorage.setItem(connectionRecoveryPathKey, location.pathname + location.search + location.hash);
              sessionStorage.setItem(connectionRecoveryKey, "reset");
              location.reload();
            } catch {}
          }, 8000);
        };

        const configureDictationShortcuts = () => {
          const key = "@paseo:keyboard-shortcut-overrides";
          let stored = {};
          try { stored = JSON.parse(localStorage.getItem(key) || "{}"); } catch {}
          localStorage.setItem(key, JSON.stringify({
            ...stored,
            "message-input-voice-toggle-cmd-shift-d-mac": null,
            "message-input-voice-toggle-ctrl-shift-d-non-mac": null,
            "message-input-voice-mute-toggle": null,
            "message-input-dictation-toggle-cmd-d-mac": "Cmd+Shift+D",
            "message-input-dictation-toggle-ctrl-d-non-mac": "Ctrl+Shift+D"
          }));
        };

        const hideStudentControls = () => {
          document.querySelectorAll("[data-testid]").forEach((element) => {
            if (hiddenTestIds.has(element.getAttribute("data-testid"))) hide(element);
          });

          document.querySelectorAll("button, [role=button], [role=menuitem], [role=link]").forEach((element) => {
            const label = (element.getAttribute("aria-label") || element.textContent || "")
              .replace(/\\s+/g, " ")
              .trim();
            if (
              hiddenLabels.has(label) ||
              label.startsWith("Claude Code ") ||
              label.startsWith("Codex ") ||
              label.startsWith("OpenCode ") ||
              label === "Pi" ||
              label.startsWith("Pi ")
            ) hide(element);
          });

          mountLearnControls();
          mountEcosystem();
          mountProviderSettings();
          positionEcosystemPage();
        };

        const removeLearnControls = () => {
          document.querySelectorAll("[data-pi-student-learn]").forEach(button => button.remove());
        };

        const isVisible = element => element.getClientRects().length > 0;

        const dictationIsActive = () =>
          [...document.querySelectorAll('[data-testid="dictation-confirm"], [data-testid="dictation-cancel"]')].some(isVisible)
          || [...document.querySelectorAll('button, [role="button"]')]
            .some(element => element.getAttribute("aria-label") === "Stop dictation" && isVisible(element));

        const mountLearnControls = () => {
          const workspaceId = location.pathname.match(/\\/workspace\\/(wks_[A-Za-z0-9_-]+)/)?.[1];
          const isNewWorkspace = location.pathname === "/new";
          if ((!workspaceId && !isNewWorkspace) || dictationIsActive()) {
            removeLearnControls();
            return;
          }
          const containers = [...document.querySelectorAll("[data-pi-student-agent-id]")];
          if (isNewWorkspace) {
            document.querySelectorAll('[data-testid="message-input-root"]').forEach(container => {
              if (!container.closest("[data-pi-student-agent-id]") && isVisible(container) && container.querySelector('[data-testid="combined-model-selector"]')) containers.push(container);
            });
          } else document.querySelector('[data-pi-student-learn][data-agent-id="draft"]')?.remove();
          containers.forEach(container => {
            const agentId = container.getAttribute("data-pi-student-agent-id");
            const isDraft = !agentId;
            const anchor = [...container.querySelectorAll('[data-testid="agent-thinking-selector"]')].find(isVisible)
              || [...container.querySelectorAll('[data-testid="agent-controls-thinking"]')].find(isVisible)
              || [...container.querySelectorAll('[data-testid="combined-model-selector"]')].find(isVisible)
              || [...container.querySelectorAll('button, [role="button"]')].find(node => !node.hasAttribute("data-pi-student-learn") && node.getClientRects().length > 0);
            if (!anchor) return;
            // AgentControls renders one native flex row beneath our display:contents
            // identity wrapper. Always resolve that row from the latest native anchor:
            // React may add the thinking control after our first mutation pass.
            let controlsRow = isDraft ? anchor.parentElement : anchor;
            while (!isDraft && controlsRow.parentElement && controlsRow.parentElement !== container) controlsRow = controlsRow.parentElement;
            if (!controlsRow || (!isDraft && controlsRow.parentElement !== container)) return;
            let anchorItem = anchor;
            while (anchorItem.parentElement && anchorItem.parentElement !== controlsRow) anchorItem = anchorItem.parentElement;
            if (anchorItem.parentElement !== controlsRow) return;
            let button = isDraft
              ? document.querySelector('[data-pi-student-learn][data-agent-id="draft"]')
              : container.querySelector("[data-pi-student-learn]");
            if (button && button.dataset.agentId !== (agentId || "draft")) { button.remove(); button = null; }
            if (button) {
              if (isDraft) {
                const rect = anchorItem.getBoundingClientRect();
                Object.assign(button.style, { left: rect.right + 4 + "px", top: rect.top + "px", height: rect.height + "px" });
                return;
              }
              // Reposition an early mount after Thinking once React has rendered it.
              // This also removes it from any native model tooltip hitbox.
              if (button.parentElement !== controlsRow || button.previousElementSibling !== anchorItem) anchorItem.insertAdjacentElement("afterend", button);
              return;
            }
            button = document.createElement("button");
            button.type = "button";
            button.dataset.piStudentLearn = "true";
            button.dataset.agentId = agentId || "draft";
            button.dataset.testid = "pi-student-learn-toggle";
            button.title = "Learn Mode: Explore and understand this codebase.";
            button.setAttribute("aria-label", "Learn Mode: Explore and understand this codebase");
            // Reuse the native control's generated classes and inline layout styles.
            // Its text node is cloned separately so theme typography/color stay exact.
            button.className = anchor.className;
            button.style.cssText = anchor.style.cssText;
            button.style.flexShrink = "0";
            button.style.whiteSpace = "nowrap";
            if (isDraft) Object.assign(button.style, { position: "fixed", zIndex: "1000", pointerEvents: "auto" });
            const anchorText = [...anchor.querySelectorAll("*")].reverse().find(node => !node.children.length && node.textContent?.trim());
            const label = anchorText ? anchorText.cloneNode(false) : document.createElement("span");
            button.appendChild(label);
            let enabled = isDraft && sessionStorage.getItem("pi-student-learn-next") === "true";
            let busy = false;
            let ready = isDraft;
            let revision = 0;
            const render = () => {
              const label = "Learn " + (enabled ? "●" : "○");
              if (button.firstChild.textContent !== label) button.firstChild.textContent = label;
              button.setAttribute("aria-pressed", String(enabled));
              button.disabled = busy || !ready;
              button.style.opacity = button.disabled ? "0.5" : "1";
            };
            // Capture identity here so a delayed request cannot update a newly selected chat.
            const request = async (options = {}) => {
              const response = await fetch(ecosystemApi + "/learn-mode?workspaceId=" + encodeURIComponent(workspaceId) + "&agentId=" + encodeURIComponent(agentId), { ...options, headers: { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" } });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error || "Learn Mode is unavailable.");
              return data.learnMode === true;
            };
            button.addEventListener("click", async () => {
              if (busy || !ready) return;
              const previous = enabled;
              revision++;
              enabled = !enabled; busy = true; render();
              if (isDraft) {
                sessionStorage.setItem("pi-student-learn-next", String(enabled));
                busy = false; render(); return;
              }
              try { enabled = await request({ method: "POST", body: JSON.stringify({ learnMode: enabled }) }); }
              catch (error) { enabled = previous; window.alert(error.message); }
              finally { busy = false; render(); }
            });
            if (isDraft) {
              const rect = anchorItem.getBoundingClientRect();
              Object.assign(button.style, { left: rect.right + 4 + "px", top: rect.top + "px", height: rect.height + "px" });
              document.body.appendChild(button);
            } else anchorItem.insertAdjacentElement("afterend", button);
            render();
            const refresh = async () => {
              if (!button.isConnected) { clearInterval(timer); return; }
              if (isDraft) return;
              if (busy) return;
              const before = revision;
              try {
                const pending = sessionStorage.getItem("pi-student-learn-next");
                const value = pending === null ? await request() : await request({ method: "POST", body: JSON.stringify({ learnMode: pending === "true" }) });
                if (pending !== null) sessionStorage.removeItem("pi-student-learn-next");
                if (before !== revision || busy) return; enabled = value; ready = true; button.title = "Learn Mode: Explore and understand this codebase.";
              }
              catch (error) { if (before !== revision || busy) return; ready = false; button.title = error.message; }
              render();
            };
            const timer = setInterval(refresh, 2000);
            void refresh();
          });
        };

        const api = async (route, options = {}) => {
		  const requestUrl = new URL(ecosystemApi + route);
		  const workspaceId = location.pathname.match(/\\/workspace\\/(wks_[A-Za-z0-9_-]+)/)?.[1];
		  if (workspaceId) requestUrl.searchParams.set("workspaceId", workspaceId);
		  const response = await fetch(requestUrl, {
            ...options,
            headers: { "Content-Type": "application/json", "X-Pi-Student": "ecosystem", ...(options.headers || {}) }
          });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "Pi could not complete that GitHub action.");
          return body;
        };

        const element = (tag, className, text) => {
          const value = document.createElement(tag);
          if (className) value.className = className;
          if (text !== undefined) value.textContent = text;
          return value;
        };

        const actionButton = (label, action, variant = "") => {
          const button = element("button", "action" + (variant ? " " + variant : ""), label);
          button.type = "button";
          button.addEventListener("click", action);
          return button;
        };

        const sectionHeader = (label, kind, expanded, action) => {
          const head = actionButton("", action);
          head.className = "section-head";
          head.setAttribute("aria-expanded", String(expanded));
          const icon = element("span", "section-icon");
          icon.setAttribute("aria-hidden", "true");
          const symbol = kind === "github"
            ? '<path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 1.72 2.63 1.22 3.27.93.1-.73.39-1.22.71-1.5-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.28-.5-1.43.11-2.98 0 0 .94-.3 3.09 1.15a10.75 10.75 0 0 1 5.62 0c2.15-1.45 3.09-1.15 3.09-1.15.61 1.55.23 2.7.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.32-2.63 5.28-5.14 5.56.4.35.76 1.03.76 2.08v3.1c0 .3.21.65.78.54A11.25 11.25 0 0 0 12 .75Z" fill="currentColor"/>'
            : '<g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V3m-5 5 5-5 5 5M5 14v6h14v-6"/></g>';
          icon.innerHTML = '<svg class="section-symbol" viewBox="0 0 24 24">' + symbol + '</svg><svg class="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + (expanded ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6') + '"/></svg>';
          head.append(icon, element("span", "", label));
          return head;
        };

        const refreshEcosystem = async () => {
          try { ecosystemState = await api("/state"); }
          catch (error) { ecosystemState = { error: error.message, github: { connected: false, repositories: [], changedFiles: 0 }, deployments: [] }; }
          renderEcosystem();
        };

        const connectGithub = () => {
          if (githubConnectPromise) return githubConnectPromise;
          const popup = window.open("about:blank", "pi-github-login");
          if (popup) { popup.document.title = "Connect GitHub"; popup.document.body.textContent = "Preparing GitHub sign-in…"; popup.opener = null; }
          githubSignIn = { status: "preparing" };
          renderEcosystem();
          githubConnectPromise = (async () => {
            let navigated = false;
            try {
              await api("/connect", { method: "POST", body: "{}" });
              while (true) {
                githubSignIn = await api("/connect");
                renderEcosystem();
                if (githubSignIn.status === "waiting" && !navigated) {
                  navigated = true;
                  if (popup && !popup.closed) popup.location.replace("https://github.com/login/device");
                }
                if (githubSignIn.status === "connected") { await refreshEcosystem(); return true; }
                if (githubSignIn.status === "failed") throw new Error(githubSignIn.error || "GitHub sign-in did not complete.");
                await new Promise(resolve => window.setTimeout(resolve, 1000));
              }
            } catch (error) {
              githubSignIn = { status: "failed", error: error.message };
              if (!navigated && popup && !popup.closed) popup.close();
              return false;
            } finally { githubConnectPromise = null; renderEcosystem(); }
          })();
          return githubConnectPromise;
        };

        const mountEcosystem = () => {
          const scroll = sidebarList();
          const host = (scroll && scroll.firstElementChild) || scroll || document.querySelector('[data-testid="sidebar-scroll-body"]') || document.querySelector('[data-testid="sidebar-view"]');
          if (!host || host.querySelector("#pi-student-ecosystem")) return;
          const mount = element("div");
          mount.id = "pi-student-ecosystem";
          const sidebar = document.querySelector('[data-testid="sidebar-view"]') || host.parentElement;
          const reference = sidebar && [...sidebar.querySelectorAll("div, span")].find(node => node.children.length === 0 && node.textContent.trim() === "Workspaces");
          if (reference) {
            const style = getComputedStyle(reference);
            mount.style.fontFamily = style.fontFamily;
            mount.style.fontSize = style.fontSize;
            mount.style.fontWeight = style.fontWeight;
            mount.style.lineHeight = style.lineHeight;
            mount.style.color = style.color;
            mount.style.setProperty("--page-primary", style.color);
            mount.style.setProperty("--page-background", getComputedStyle(document.body).backgroundColor);
          }
          const shadow = mount.attachShadow({ mode: "open" });
          shadow.innerHTML = '<style>:host{display:block;color:inherit;font:inherit}.wrap{border-top:1px solid rgba(127,127,127,.2);padding:10px 8px}.eyebrow{font-size:10px;font-weight:700;letter-spacing:.11em;opacity:.55;padding:4px 7px}.section{margin-top:3px}.section-head{width:100%;border:0;background:transparent;color:inherit;display:flex;gap:7px;align-items:center;padding:7px;border-radius:7px;text-align:left;font:inherit;cursor:pointer}.section-icon{display:grid;place-items:center;width:16px;height:16px;flex:none}.section-icon svg{grid-area:1/1;width:16px;height:16px}.section-chevron{opacity:0}.section-head:hover .section-symbol,.section-head:focus-visible .section-symbol{opacity:0}.section-head:hover .section-chevron,.section-head:focus-visible .section-chevron{opacity:1}.section-head:focus-visible{outline:2px solid currentColor;outline-offset:-2px}.section-head:hover,.item:hover{background:rgba(127,127,127,.12)}.body{padding:2px 7px 8px 27px;display:grid;gap:5px}.muted{opacity:.58}.ok{color:#2da66f}.bad{color:#d85c5c}.item{border:0;background:transparent;color:inherit;text-align:left;padding:3px 0;border-radius:5px;font:inherit;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.link{border:0;background:transparent;color:#3b82f6;text-align:left;padding:4px 0;font:inherit;cursor:pointer}.action{border:1px solid rgba(127,127,127,.3);background:transparent;color:inherit;border-radius:7px;padding:7px 10px;font:inherit;cursor:pointer}.action.primary{background:var(--page-primary,currentColor);color:var(--page-background,#181b1a);border-color:transparent}.action.success{background:#16a34a;border-color:#16a34a;color:#fff}.action.danger{background:#dc2626;border-color:#dc2626;color:#fff}.actions{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}.provider-input{box-sizing:border-box;min-width:220px;max-width:100%;padding:8px 10px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:7px;background:transparent;color:inherit;font:inherit}.panel-backdrop{position:fixed;background:var(--page-background);color:inherit;z-index:10;overflow:auto;font-size:14px;line-height:1.5}.panel{box-sizing:border-box;width:min(100%,880px);min-height:100%;margin:0 auto;padding:32px clamp(20px,4vw,48px) 48px}.panel h2{margin:20px 0 16px;font-size:24px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}.panel h3{font-size:14px;font-weight:600;margin:28px 0 12px}.card{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:8px;padding:16px;margin:8px 0;overflow-wrap:anywhere}.row{display:flex;justify-content:space-between;gap:24px;padding:12px 0;border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent)}.row span:first-child{opacity:.6;flex-shrink:0}.row span:last-child{text-align:right;overflow-wrap:anywhere;min-width:0}.close{border:0;background:none;color:inherit;cursor:pointer;font:inherit;padding:4px 0;opacity:.65}.panel .item{display:block;width:100%;padding:12px;margin:8px 0;border:1px solid color-mix(in srgb,currentColor 14%,transparent)}button:focus-visible{outline:2px solid currentColor;outline-offset:3px}.action:hover{background:color-mix(in srgb,currentColor 10%,transparent)}.action.primary:hover{background:color-mix(in srgb,var(--page-primary,currentColor) 84%,transparent)}.action.success:hover{background:#15803d;border-color:#15803d}.action.danger:hover{background:#b91c1c;border-color:#b91c1c}.error{color:#ff8f8f;white-space:pre-wrap}.progress{padding:7px;border-radius:7px;background:rgba(52,120,212,.12)}</style><div class="wrap"></div>';
          shadow.querySelector("style").textContent += '.link{color:#2563eb!important;-webkit-text-fill-color:#2563eb!important}';
          host.appendChild(mount);
          document.querySelector("#pi-student-ecosystem-page")?.remove();
          const pageMount = element("div");
          pageMount.id = "pi-student-ecosystem-page";
          const pageShadow = pageMount.attachShadow({ mode: "open" });
          pageShadow.innerHTML = '<style>' + shadow.querySelector("style").textContent + '</style><div class="page-root"></div>';
          document.body.appendChild(pageMount);
          refreshEcosystem();
          if (!refreshTimer) refreshTimer = window.setInterval(refreshEcosystem, 5000);
        };

        const renderEcosystem = () => {
          const mount = document.querySelector("#pi-student-ecosystem");
          const wrap = mount && mount.shadowRoot && mount.shadowRoot.querySelector(".wrap");
          const pageRoot = document.querySelector("#pi-student-ecosystem-page")?.shadowRoot?.querySelector(".page-root");
          if (!wrap || !pageRoot || !ecosystemState) return;
          wrap.replaceChildren(element("div", "eyebrow", "ECOSYSTEM"));
          wrap.appendChild(renderGithubQuick());
          wrap.appendChild(renderDeploymentsQuick());
          pageRoot.replaceChildren();
          if (ecosystemView) {
            pageRoot.appendChild(renderPanel());
            positionEcosystemPage();
          }
        };

        const renderGithubQuick = () => {
          const section = element("div", "section");
          const github = ecosystemState.github || {};
          const head = sectionHeader("GitHub", "github", githubOpen, () => { githubOpen = !githubOpen; renderEcosystem(); });
          head.className = "section-head";
          section.appendChild(head);
          if (!githubOpen) return section;
          const body = element("div", "body");
          if (!github.connected) {
            const pending = githubSignIn && ["preparing", "waiting"].includes(githubSignIn.status);
            body.appendChild(element("div", "muted", pending ? (githubSignIn.status === "preparing" ? "Preparing sign-in…" : "Finish signing in on GitHub") : "Not connected"));
            if (githubSignIn && githubSignIn.code) {
              body.appendChild(element("div", "", "Your sign-in code: " + githubSignIn.code));
              body.appendChild(actionButton("Copy code", () => navigator.clipboard.writeText(githubSignIn.code)));
              body.appendChild(actionButton("Open GitHub", () => window.open("https://github.com/login/device", "_blank", "noopener")));
            }
            if (githubSignIn && githubSignIn.error) body.appendChild(element("div", "error", githubSignIn.error));
            const connect = actionButton(pending ? "Waiting for GitHub…" : "Connect", connectGithub, "primary");
            connect.disabled = !!pending;
            body.appendChild(connect);
          } else {
            body.appendChild(element("div", "ok", "✓ @" + github.username));
            if (github.currentRepository) {
              body.appendChild(element("div", "muted", "Current repository"));
              body.appendChild(element("div", "", github.currentRepository.owner + "/" + github.currentRepository.repo));
            const sync = github.changedFiles ? github.changedFiles + " changed files" : github.ahead ? github.ahead + " commits ahead" : github.behind ? github.behind + " commits behind" : "synced";
            body.appendChild(element("div", "muted", (github.branch || github.currentRepository.branch) + " · " + sync));
            }
            (github.repositories || []).slice(0, 3).forEach(repo => {
              const item = element("button", "item", repo.fullName);
              item.addEventListener("click", () => { ecosystemView = { type: "repository", item: repo }; renderEcosystem(); });
              body.appendChild(item);
            });
            const view = element("button", "link", "View GitHub →");
            view.style.setProperty("color", "#2563eb", "important");
            view.style.setProperty("-webkit-text-fill-color", "#2563eb", "important");
            view.addEventListener("click", () => { ecosystemView = { type: "github" }; renderEcosystem(); });
            body.appendChild(view);
          }
          section.appendChild(body);
          return section;
        };

        const renderDeploymentsQuick = () => {
          const section = element("div", "section");
          const head = sectionHeader("Deployments", "deploy", deploymentsOpen, () => { deploymentsOpen = !deploymentsOpen; renderEcosystem(); });
          head.className = "section-head";
          section.appendChild(head);
          if (!deploymentsOpen) return section;
          const body = element("div", "body");
          const current = ecosystemState.currentProject && ecosystemState.currentProject.deployment;
          if (ecosystemState.publishing && ecosystemState.progress) body.appendChild(element("div", "progress", "○ " + ecosystemState.progress.message));
          if (current) body.appendChild(deploymentItem(ecosystemState.currentProject));
          else body.appendChild(element("div", "muted", "Current project not published"));
          body.appendChild(actionButton("Publish", publishFromGui));
          const view = element("button", "link", "View all deployments →");
          view.style.setProperty("color", "#2563eb", "important");
          view.style.setProperty("-webkit-text-fill-color", "#2563eb", "important");
          view.addEventListener("click", () => { ecosystemView = { type: "deployments" }; renderEcosystem(); });
          body.appendChild(view);
          section.appendChild(body);
          return section;
        };

        const deploymentItem = project => {
          const deployment = project.deployment;
          const label = (deployment.status === "published" ? "● " : deployment.status === "failed" ? "✕ " : "○ ") + project.projectName + " · " + deployment.status;
          const item = element("button", "item " + (deployment.status === "published" ? "ok" : deployment.status === "failed" ? "bad" : ""), label);
          item.addEventListener("click", () => { ecosystemView = { type: "deployment", item: project }; renderEcosystem(); });
          return item;
        };

        const publishFromGui = async () => {
          if (!ecosystemState.github.connected && !(await connectGithub())) return;
          const first = !(ecosystemState.currentProject && ecosystemState.currentProject.github);
          if (first && !window.confirm("Publishing will create a public GitHub repository. Anyone will be able to view the source code and published site.\\n\\nContinue?")) return;
          try { await api("/publish", { method: "POST", body: JSON.stringify({ confirmedPublic: first }) }); await refreshEcosystem(); }
          catch (error) { window.alert(error.message); }
        };

		const removeSiteFromGui = async project => {
		  if (!window.confirm("Remove this site from GitHub Pages?\\n\\nThe public site will no longer be available. The GitHub repository and all of its files will remain unchanged.")) return;
		  try {
			await api("/remove-site", { method: "POST", body: JSON.stringify({ projectPath: project.projectPath }) });
			ecosystemView = { type: "deployments" };
			await refreshEcosystem();
		  } catch (error) { window.alert(error.message); }
		};

        const renderPanel = () => {
          const backdrop = element("section", "panel-backdrop");
          backdrop.setAttribute("aria-label", ecosystemView.type.startsWith("deploy") ? "Deployments" : "GitHub");
          const panel = element("div", "panel");
          const close = actionButton("← Back to workspace", closeEcosystemPage);
          close.className = "close";
          close.setAttribute("aria-label", "Back to workspace");
          panel.appendChild(close);
          if (ecosystemView.type === "github") renderGithubPanel(panel);
          else if (ecosystemView.type === "repository") renderRepositoryPanel(panel, ecosystemView.item);
          else if (ecosystemView.type === "deployments") renderDeploymentsPanel(panel);
          else renderDeploymentPanel(panel, ecosystemView.item);
          backdrop.appendChild(panel);
          return backdrop;
        };

        const renderGithubPanel = panel => {
          panel.appendChild(element("h2", "", "GitHub"));
          const github = ecosystemState.github;
          panel.appendChild(element("div", github.connected ? "ok" : "muted", github.connected ? "✓ Connected as @" + github.username : "Not connected"));
          panel.appendChild(element("h3", "", "Repositories"));
          (github.repositories || []).forEach(repo => panel.appendChild(repositoryCard(repo)));
        };

        const mountProviderSettings = () => {
          const host = document.querySelector('[data-testid="host-page-providers-card"]');
          document.querySelectorAll("[data-pi-student-model-providers]").forEach(node => { if (!host || !host.contains(node)) node.remove(); });
          if (!host || host.querySelector("[data-pi-student-model-providers]")) return;
          const section = element("div", "");
          section.dataset.piStudentModelProviders = "true";
          Object.assign(section.style, { borderTop: "1px solid rgba(127,127,127,.22)", marginTop: "18px", paddingTop: "18px", color: "inherit", font: "inherit" });
          const textReference = [...host.querySelectorAll("div")].find(node => node.children.length === 0 && node.textContent.trim() === "Providers");
          section.style.color = getComputedStyle(textReference || host).color;
          const title = element("div", "", "Pi Student model providers");
          Object.assign(title.style, { fontSize: "16px", fontWeight: "600", marginBottom: "5px" });
          const intro = element("div", "", "Connect providers for Pi Student models. These connections are shared with the TUI and stored in Pi's local credential files.");
          Object.assign(intro.style, { opacity: ".68", marginBottom: "14px" });
          const status = Object.create(null);
          const cards = Object.create(null);
          const addCard = (id, label, description) => {
            const card = element("div", "");
            Object.assign(card.style, { border: "1px solid rgba(127,127,127,.2)", borderRadius: "8px", padding: "14px", margin: "10px 0" });
            const head = element("div", "", label); Object.assign(head.style, { fontWeight: "600", marginBottom: "4px" });
            const state = element("div", "", description); Object.assign(state.style, { opacity: ".68" });
            const models = element("div", "", ""); Object.assign(models.style, { opacity: ".68", marginTop: "5px" });
            card.append(head, state, models); section.appendChild(card);
            status[id] = state; cards[id] = { card, models };
            return card;
          };
          const input = (label, placeholder, type = "text") => {
            const field = element("input", "");
            field.type = type; field.placeholder = placeholder; field.setAttribute("aria-label", label);
            Object.assign(field.style, { boxSizing: "border-box", minWidth: "240px", maxWidth: "100%", padding: "8px 10px", marginRight: "8px", border: "1px solid rgba(127,127,127,.3)", borderRadius: "6px", background: "transparent", color: "inherit", font: "inherit" });
            return field;
          };
          const button = (label, action) => {
            const control = element("button", "", label); control.type = "button";
            Object.assign(control.style, { padding: "8px 12px", marginTop: "8px", border: "1px solid rgba(127,127,127,.3)", borderRadius: "6px", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" });
            control.addEventListener("click", action); return control;
          };
          const openai = addCard("openai", "OpenAI API", "Connect with an OpenAI API key.");
          const openaiKey = input("OpenAI API key", "sk-…", "password"); openaiKey.autocomplete = "new-password";
          openai.appendChild(openaiKey);
          openai.appendChild(button("Save API key", async event => {
            const control = event.currentTarget; if (!openaiKey.value.trim()) return;
            control.disabled = true;
            try { await api("/providers/openai", { method: "POST", body: JSON.stringify({ apiKey: openaiKey.value }) }); openaiKey.value = ""; await refreshProviderSettings(); }
            catch (error) { status.openai.textContent = error.message; }
            finally { control.disabled = false; }
          }));
          const codex = addCard("openai-codex", "Codex", "Connect your ChatGPT account.");
          const codexStatus = element("div", ""); Object.assign(codexStatus.style, { marginTop: "8px" }); codex.appendChild(codexStatus);
          const promptRoot = element("div", ""); codex.appendChild(promptRoot);
          let promptSignature = "";
          let codexLoginActive = false;
          const connectCodex = button("Connect Codex", async event => {
            const control = event.currentTarget; control.disabled = true;
            try { await api("/providers/codex/login", { method: "POST", body: "{}" }); codexLoginActive = true; void pollCodex(); }
            catch (error) { status["openai-codex"].textContent = error.message; control.disabled = false; }
          }); codex.appendChild(connectCodex);
          const ollama = addCard("ollama", "Ollama", "Connect a local Ollama server with downloaded models.");
          const ollamaUrl = input("Ollama server address", "http://127.0.0.1:11434"); ollama.appendChild(ollamaUrl);
          ollama.appendChild(button("Connect Ollama", async event => {
            const control = event.currentTarget; control.disabled = true;
            try { await api("/providers/ollama", { method: "POST", body: JSON.stringify({ url: ollamaUrl.value }) }); await refreshProviderSettings(); }
            catch (error) { status.ollama.textContent = error.message; }
            finally { control.disabled = false; }
          }));
          host.appendChild(section);

          const refreshProviderSettings = async () => {
            try {
              const data = await api("/providers");
              data.providers.forEach(provider => {
                status[provider.id].textContent = provider.configured ? "✓ Connected" : "Not connected";
                cards[provider.id].models.textContent = provider.models?.length ? "Models: " + provider.models.slice(0, 6).join(", ") + (provider.models.length > 6 ? "…" : "") : "";
                if (provider.id === "openai-codex") connectCodex.textContent = provider.configured ? "Reconnect Codex" : "Sign in to Codex";
              });
              ollamaUrl.value = data.ollamaUrl || ollamaUrl.value;
              const login = data.codexLogin;
              if (login?.status !== "connecting") { codexLoginActive = false; connectCodex.disabled = false; }
              else connectCodex.disabled = true;
              codexStatus.textContent = login?.status === "connecting" ? (login.message || "Waiting for Codex sign-in…") : login?.status === "failed" ? (login.error || "Codex sign-in failed.") : login?.status === "connected" ? (login.message || "Codex connected.") : "";
              if (login?.url) {
                codexStatus.appendChild(document.createTextNode(" "));
                const open = button(login.code ? "Open sign-in page · code " + login.code : "Open Codex sign-in", () => window.open(login.url, "_blank", "noopener"));
                codexStatus.appendChild(open);
              }
              const prompt = login?.prompt;
              const signature = prompt ? JSON.stringify(prompt) : "";
              if (signature !== promptSignature) {
                promptSignature = signature; promptRoot.replaceChildren();
                if (prompt) {
                  promptRoot.appendChild(element("div", "", prompt.message));
                  prompt.options?.forEach((option, index) => promptRoot.appendChild(element("div", "", (index + 1) + ". " + option.label + (option.description ? " — " + option.description : ""))));
                  const answer = input("Codex sign-in response", prompt.type === "select" ? "Enter a number" : "Enter the requested value", prompt.type === "secret" ? "password" : "text");
                  promptRoot.appendChild(answer);
                  promptRoot.appendChild(button("Continue", async () => { await api("/providers/codex/answer", { method: "POST", body: JSON.stringify({ answer: answer.value }) }); promptSignature = ""; await refreshProviderSettings(); }));
                }
              }
            } catch (error) { status.openai.textContent = error.message; }
          };
          const pollCodex = async () => {
            await refreshProviderSettings();
            if (codexLoginActive) window.setTimeout(pollCodex, 1200);
          };
          void refreshProviderSettings();
        };

        const repositoryCard = repo => {
          const card = element("div", "card");
          card.appendChild(element("strong", "", repo.fullName));
          card.appendChild(element("div", "muted", repo.visibility + " · " + repo.defaultBranch));
          const actions = element("div", "actions");
          actions.appendChild(actionButton("Open repository", () => window.open(repo.url, "_blank", "noopener")));
          actions.appendChild(actionButton("Copy URL", () => navigator.clipboard.writeText(repo.url)));
          card.appendChild(actions);
          return card;
        };

        const renderRepositoryPanel = (panel, repo) => { panel.appendChild(element("h2", "", repo.fullName)); panel.appendChild(repositoryCard(repo)); const current = ecosystemState.currentProject && ecosystemState.currentProject.deployment; if (current && current.repositoryUrl === repo.url) { panel.appendChild(element("h3", "", "Deployment")); panel.appendChild(actionButton("View deployment", () => { ecosystemView = { type: "deployment", item: ecosystemState.currentProject }; renderEcosystem(); })); } };

        const renderDeploymentsPanel = panel => {
          panel.appendChild(element("h2", "", "Deployments"));
          const filters = element("div", "muted", "All · Live · Building · Failed · Not published"); panel.appendChild(filters);
          if (!(ecosystemState.deployments || []).length) panel.appendChild(element("div", "muted", "No projects have been published yet."));
          (ecosystemState.deployments || []).forEach(project => panel.appendChild(deploymentItem(project)));
        };

        const renderDeploymentPanel = (panel, project) => {
          const deployment = project.deployment;
          panel.appendChild(element("h2", "", project.projectName));
          [["Status", deployment.status], ["Provider", deployment.providerLabel], ["Repository", project.github ? project.github.owner + "/" + project.github.repo : "—"], ["Branch", deployment.branch], ["Deployment type", deployment.deploymentType], ["Live URL", deployment.url || "—"]].forEach(values => { const row = element("div", "row"); row.appendChild(element("span", "", values[0])); row.appendChild(element("span", "", values[1])); panel.appendChild(row); });
          const actions = element("div", "actions");
          if (deployment.url) { actions.appendChild(actionButton("Open site", () => window.open(deployment.url, "_blank", "noopener"), "primary")); actions.appendChild(actionButton("Copy URL", () => navigator.clipboard.writeText(deployment.url))); }
          actions.appendChild(actionButton("View repository", () => window.open(deployment.repositoryUrl, "_blank", "noopener")));
          actions.appendChild(actionButton("Publish", publishFromGui, "success"));
          actions.appendChild(actionButton("Remove site", () => removeSiteFromGui(project), "danger"));
          panel.appendChild(actions);
          if (deployment.lastError) { panel.appendChild(element("h3", "", "Build failed")); panel.appendChild(element("div", "error", deployment.lastError)); panel.appendChild(actionButton("Ask Pi for help", () => { navigator.clipboard.writeText("Help me diagnose this deployment failure:\\n" + deployment.lastError); window.alert("The failure was copied. Paste it into Pi to ask for help."); })); }
          panel.appendChild(element("h3", "", "Deployment history"));
          (deployment.history || []).forEach(item => panel.appendChild(element("div", "card", (item.status === "published" ? "✓ Published" : "✕ Failed") + (item.commit ? " · " + item.commit : "") + "\\n" + new Date(item.at).toLocaleString())));
        };

        const start = () => {
          hideStudentControls();
          window.addEventListener("resize", positionEcosystemPage);
          window.addEventListener("resize", mountLearnControls);
          pageResizeObserver = new ResizeObserver(positionEcosystemPage);
          pageResizeObserver.observe(document.body);
          document.addEventListener("click", event => {
            if (!ecosystemView) return;
            const path = event.composedPath();
            if (path.some(node => node.id === "pi-student-ecosystem" || node.id === "pi-student-ecosystem-page")) return;
            if (path.some(node => node.matches?.('a, button, [role="button"], [role="link"], [role="menuitem"]'))) closeEcosystemPage();
          }, true);
          window.addEventListener("popstate", () => { closeEcosystemPage(); hideStudentControls(); });
          for (const method of ["pushState", "replaceState"]) {
            const original = history[method];
            history[method] = function(...args) {
              const result = original.apply(this, args);
              closeEcosystemPage();
              hideStudentControls();
              return result;
            };
          }
          new MutationObserver(hideStudentControls).observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["data-pi-student-agent-id", "aria-label"]
          });
        };

        // Capture before Paseo's shortcut handler: Shift+D is realtime voice
        // upstream. Use the dictation button so stopping inserts, never sends.
        window.addEventListener("keydown", (event) => {
          if (!(event.ctrlKey || event.metaKey) || event.altKey || event.code !== "KeyD") return;
          if (event.target instanceof Element && event.target.closest(".xterm, [data-testid=file-source-editor]")) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (event.repeat) return;
          const buttons = [...document.querySelectorAll('button, [role="button"]')];
          const button = buttons.find((element) =>
            ["Start dictation", "Stop dictation"].includes(element.getAttribute("aria-label")) &&
            element.getClientRects().length > 0 && !element.disabled && element.getAttribute("aria-disabled") !== "true"
          );
          button?.click();
        }, true);

        installConnectionRecovery();
        keepWorkVisible();
        configureDictationShortcuts();
        if (document.body) start();
        else document.addEventListener("DOMContentLoaded", start, { once: true });
      })();
    </script>`;

export async function patchPaseoWebUi(paseoExecutable: string, ecosystemPort = 6769): Promise<boolean> {
	const indexPath = path.resolve(
		path.dirname(paseoExecutable),
		"..",
		"..",
		"node_modules",
		"@getpaseo",
		"server",
		"dist",
		"server",
		"web-ui",
		"index.html",
	);
	try {
		await access(indexPath);
	} catch {
		// Test runners and alternate Paseo installations may not expose the
		// npm package layout. In that case Paseo still starts normally.
		return false;
	}

	await patchLearnControlsBundle(indexPath);
	const original = await readFile(indexPath, "utf8");
	const script = studentUiScript(ecosystemPort) + flowchartUiScript(ecosystemPort);
	if (original.includes(script)) return false;
	const html = original
		.replace(/\s*<script data-pi-student-ui="[^"]*">[\s\S]*?<\/script>/g, "")
		.replace(/\s*<script data-pi-student-flowchart="[^"]*">[\s\S]*?<\/script>/g, "");
	const insertionPoint = "</head>";
	if (!html.includes(insertionPoint)) throw new Error(`Paseo web UI is missing its head element: ${indexPath}`);
	await writeFile(indexPath, html.replace(insertionPoint, `${script}\n  ${insertionPoint}`));
	return true;
}
