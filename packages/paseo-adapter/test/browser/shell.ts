/**
 * A minimal stand-in for Paseo's web shell, bundled for the browser journey test.
 * It provides the DOM hooks and editor/terminal objects that Paseo gives Pi
 * Student's injected scripts: the workspace route, the tabs row, a Chat panel
 * tagged with its agent id, a real CodeMirror EditorView handed to
 * `piStudentFileEditor`, and a real xterm Terminal exposed as `__paseoTerminal`
 * that receives the same OSC 633 command markers as Paseo's zsh integration.
 * Everything Pi Student renders or reports comes from its production scripts.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Terminal } from "@xterm/headless";

declare global {
	interface Window {
		piStudentFileEditor?: (view: EditorView, filename: string) => (() => void) | undefined;
		__paseoTerminal?: Terminal;
		__terminalAttached?: boolean;
		shell: { navigate(workspaceId: string): Promise<void>; editor(): EditorView | undefined; saved(): Promise<void> };
	}
}

const agents = JSON.parse(document.body.dataset.agents ?? "{}") as Record<string, string>;
const workspace = () => location.pathname.match(/\/workspace\/(wks_[A-Za-z0-9_-]+)/)?.[1];
const element = (id: string) => document.getElementById(id)!;
const FILE = "score.js";

// Terminal: Paseo's xterm instance. Pi Student attaches to it on its own schedule.
const terminal = new Terminal({ allowProposedApi: true, cols: 120, rows: 30, scrollback: 500 });
const registerOscHandler = terminal.parser.registerOscHandler.bind(terminal.parser);
terminal.parser.registerOscHandler = (identifier, callback) => { window.__terminalAttached = true; return registerOscHandler(identifier, callback); };
window.__paseoTerminal = terminal;
const renderTerminal = () => {
	const buffer = terminal.buffer.active, lines: string[] = [];
	for (let line = 0; line < buffer.length; line++) lines.push(buffer.getLine(line)?.translateToString(true) ?? "");
	element("terminal-output").textContent = lines.join("\n").trimEnd();
};
const write = (data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
element("terminal-form").addEventListener("submit", async event => {
	event.preventDefault();
	const input = element("terminal-command") as HTMLInputElement;
	const command = input.value.trim();
	const id = workspace();
	if (!command || !id) return;
	input.value = "";
	element("terminal-status").textContent = "running";
	// Paseo's shell integration: output starts (C), the title becomes the command line, finished with an exit code (D).
	await write(`$ ${command}\r\n\x1b]633;C\x07\x1b]0;${command}\x07`);
	const result = await (await fetch(`/harness/run?workspace=${id}`, { method: "POST", body: command })).json() as { output: string; exitCode: number };
	await write(`${result.output.replace(/\r?\n/g, "\r\n")}\r\n\x1b]633;D;${result.exitCode}\x07`);
	renderTerminal();
	element("terminal-status").textContent = `exit ${result.exitCode}`;
});

// Editor: a real CodeMirror view per open file, saved like Paseo's file editor.
let editor: { view: EditorView; cleanup?: () => void } | undefined;
let pendingSave: Promise<unknown> = Promise.resolve();
const mountEditor = async (id: string) => {
	editor?.cleanup?.();
	editor?.view.destroy();
	editor = undefined;
	const content = await (await fetch(`/harness/file?workspace=${id}&file=${FILE}`)).text();
	if (workspace() !== id) return;
	const view = new EditorView({ parent: element("editor"), state: EditorState.create({ doc: content, extensions: [
		EditorView.updateListener.of(update => {
			if (!update.docChanged) return;
			const text = update.state.doc.toString();
			pendingSave = pendingSave.then(() => fetch(`/harness/file?workspace=${id}&file=${FILE}`, { method: "PUT", body: text }));
		}),
	] }) });
	editor = { view, cleanup: window.piStudentFileEditor?.(view, FILE) ?? undefined };
	element("editor-file").textContent = FILE;
};

// Chat: the Pi conversation for this workspace. The harness runs its extension hooks.
const renderChat = (id: string) => {
	element("chat").setAttribute("data-pi-student-agent-id", agents[id] ?? "");
	element("chat-transcript").replaceChildren();
};
element("chat-send").addEventListener("click", async () => {
	const id = workspace(), input = element("chat-input") as HTMLTextAreaElement;
	const response = await fetch(`/harness/chat?workspace=${id}&agent=${agents[id!]}`, { method: "POST", body: input.value });
	const turn = document.createElement("pre");
	turn.className = "turn";
	turn.textContent = await response.text();
	element("chat-transcript").append(turn);
	input.value = "";
});

// Tabs: "+" opens the new-tab menu that Pi Student adds its Map entry to.
element("new-tab").addEventListener("click", () => { element("menu").hidden = !element("menu").hidden; });
// Like Paseo's menus, choosing an entry dismisses the menu through its backdrop.
element("menu-backdrop").addEventListener("click", () => { element("menu").hidden = true; });
element("menu").addEventListener("click", () => { element("menu").hidden = true; });

const render = async () => {
	const id = workspace();
	if (!id) return;
	element("workspace-title").textContent = id;
	renderChat(id);
	await mountEditor(id);
};
window.shell = {
	async navigate(id) {
		history.pushState(history.state, "", `/workspace/${id}`);
		window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
		await render();
	},
	editor: () => editor?.view,
	saved: async () => { await pendingSave; },
};
void render();
