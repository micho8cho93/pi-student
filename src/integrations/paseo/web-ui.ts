import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const STUDENT_UI_MARKER = "data-pi-student-ui=\"student-v2\"";

// Paseo owns the bundled web UI, so keep this small student-specific shell
// override here rather than forking the whole vendor web application.
const STUDENT_UI_SCRIPT = `
    <script ${STUDENT_UI_MARKER}>
      (() => {
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
          "Manage profiles"
        ]);

        const hide = (element) => {
          element.hidden = true;
          element.setAttribute("aria-hidden", "true");
          element.style.setProperty("display", "none", "important");
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
        };

        const start = () => {
          hideStudentControls();
          new MutationObserver(hideStudentControls).observe(document.body, {
            childList: true,
            subtree: true
          });
        };

        if (document.body) start();
        else document.addEventListener("DOMContentLoaded", start, { once: true });
      })();
    </script>`;

export async function patchPaseoWebUi(paseoExecutable: string): Promise<boolean> {
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

	const html = await readFile(indexPath, "utf8");
	if (html.includes(STUDENT_UI_MARKER)) return false;
	const insertionPoint = "</head>";
	if (!html.includes(insertionPoint)) throw new Error(`Paseo web UI is missing its head element: ${indexPath}`);
	await writeFile(indexPath, html.replace(insertionPoint, `${STUDENT_UI_SCRIPT}\n  ${insertionPoint}`));
	return true;
}
