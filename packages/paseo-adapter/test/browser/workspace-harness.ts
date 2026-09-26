import { execFile } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { EffectivePolicy } from "@pi-student/contracts";
import { createLearningSession } from "@pi-student/education/types";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import { resolveExecutionContext } from "@pi-student/runtime/execution-context";
import { createProjectCapabilitiesExtension } from "@pi-student/runtime/project-capabilities";
import { resolveStudentCapabilities, type StudentCapabilityInputs } from "@pi-student/runtime/student-workspace";
import { createWorkspaceActivity } from "@pi-student/runtime/workspace-activity";
import { WorkspaceEventJournal, WorkspaceEventStream } from "@pi-student/runtime/workspace-events";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import { createEcosystemBridgeServer } from "../../src/ecosystem-bridge.js";
import { editorCompletionUiScript } from "../../src/editor-completion-ui.js";
import { flowchartUiScript } from "../../src/flowchart-ui.js";
import { projectProgressUiScript } from "../../src/project-progress-ui.js";
import { terminalActivityUiScript } from "../../src/terminal-activity-ui.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

/** System Chrome/Chromium: GitHub's ubuntu runners and developer machines have one; PI_STUDENT_TEST_BROWSER overrides. */
export function findBrowser(): string | undefined {
	const candidates = [process.env.PI_STUDENT_TEST_BROWSER, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium", "/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
		"/usr/bin/chromium", "/usr/bin/chromium-browser"];
	return candidates.find(candidate => candidate && existsSync(candidate));
}

export const WORKING = "export function score() { return 2; }\n";
const WORKSPACES = { wks_a: "project-a", wks_b: "project-b" } as const;
export type WorkspaceId = keyof typeof WORKSPACES;
const AGENTS: Record<WorkspaceId, string> = { wks_a: "agent-a", wks_b: "agent-b" };
/** Every Pi conversation Paseo knows about: project A has a second one, for two sessions in one project. */
const CONVERSATIONS = [{ agent: "agent-a", workspace: "wks_a", session: "session-wks_a" }, { agent: "agent-a2", workspace: "wks_a", session: "session-wks_a-second" },
	{ agent: "agent-b", workspace: "wks_b", session: "session-wks_b" }] as const;
export type AgentId = typeof CONVERSATIONS[number]["agent"];
// The test prints noise and a credential-like line around the failure, as real test runners do.
const TEST_SCRIPT = [
	"import { score } from './score.js';",
	"for (let i = 0; i < 40; i++) console.log('  ✓ unrelated check ' + i);",
	"console.log('TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 loaded from the environment');",
	"if (score() !== 2) { console.error('FAIL score.test.js > awards two points\\nAssertionError: expected ' + score() + ' to equal 2'); process.exitCode = 1; }",
	"else console.log('PASS score.test.js');",
].join("\n");

async function body(request: IncomingMessage): Promise<string> {
	let value = "";
	for await (const chunk of request) { value += String(chunk); if (value.length > 100_000) throw new Error("too large"); }
	return value;
}

type Handler = (event: any, ctx: any) => Promise<any>;

/**
 * Real bridge, journal, files, subprocesses, policy/capability/workflow code and
 * GUI scripts. The model's responses and Pi's extension dispatcher are controlled.
 */
export async function startBrowserWorkspace(options: { policy?: EffectivePolicy } = {}) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-browser-journey-")));
	const previousHome = process.env.PI_STUDENT_HOME;
	process.env.PI_STUDENT_HOME = path.join(root, "home");
	const paseoHome = path.join(root, "paseo");
	const projects = Object.fromEntries(Object.entries(WORKSPACES).map(([id, name]) => [id, path.join(root, name)])) as Record<WorkspaceId, string>;
	const sessionFile = (agent: AgentId) => path.join(root, "sessions", `${agent}.jsonl`);
	await mkdir(path.join(paseoHome, "projects"), { recursive: true });
	await mkdir(path.join(root, "sessions"));
	await writeFile(path.join(paseoHome, "projects", "workspaces.json"), JSON.stringify(Object.entries(projects).map(([workspaceId, cwd]) => ({ workspaceId, cwd }))));
	for (const [id, cwd] of Object.entries(projects) as Array<[WorkspaceId, string]>) {
		await mkdir(cwd);
		await writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: WORKSPACES[id], type: "module", scripts: { test: "node test.mjs" } }));
		await writeFile(path.join(cwd, "score.js"), "export function score() { return 0; }\n");
		await writeFile(path.join(cwd, "test.mjs"), `${TEST_SCRIPT}\n`);
		await writeFile(path.join(cwd, ".env"), "API_KEY=sk-live-must-never-leave-the-host\n");
		// Paseo's agent registry: each Pi conversation has a session id and a session file.
		const agents = path.join(paseoHome, "agents", cwd.replace(/^\//, "").replace(/[\\/]/g, "-"));
		await mkdir(agents, { recursive: true });
		for (const conversation of CONVERSATIONS.filter(item => item.workspace === id)) {
			await writeFile(path.join(agents, `${conversation.agent}.json`), JSON.stringify({ id: conversation.agent, provider: "pi-student", workspaceId: id, cwd,
				runtimeInfo: { sessionId: conversation.session }, persistence: { nativeHandle: sessionFile(conversation.agent) } }));
		}
	}

	const state = { outage: false };
	const modelRequests: Array<{ systemPrompt: string; messages: unknown }> = [];
	const model = { provider: "school", id: "tutor", name: "Tutor", reasoning: false, cost: { input: 0, output: 0 } };
	// Configured on this machine but never approved by any policy used in these tests.
	const rogue = { provider: "other", id: "rogue", name: "Rogue", reasoning: false, cost: { input: 0, output: 0 } };
	const runtime = {
		getAvailable: async () => options.policy ? [rogue, model] : [model], getProviderAuthStatus: () => ({ configured: true }),
		completeSimple: async (_model: unknown, request: { systemPrompt: string; messages: unknown }) => {
			modelRequests.push(request);
			if (state.outage) throw new Error("503 provider unavailable");
			return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ title: "Score flow", summary: "How points are awarded", nodes: [
				{ id: "start", label: "Run the game", type: "start" },
				{ id: "score", label: "Award points", detail: "Returns the score", explanation: "Decides how many points a player earns.", type: "action", file: "score.js", symbol: "score" },
			], edges: [{ from: "start", to: "score", label: "" }] }) }] };
		},
	} as unknown as ModelRuntime;
	// Personal context; `policy` stands in for an already resolved project policy (organization → class → project).
	const context = async (cwd: string) => ({ ...await resolveExecutionContext({ workspacePath: cwd, selection: {},
		identityProvider: { getIdentity: async () => ({ kind: "personal" as const }) }, policyProvider: { resolvePolicy: async () => undefined } }),
		...(options.policy ? { policy: options.policy } : {}) });

	// One Chat per workspace, as Pi runs it: WorkflowController, capability guard and workspace activity hooks.
	const journal = new WorkspaceEventJournal();
	const chats = new Map<AgentId, Awaited<ReturnType<typeof createChat>>>();
	const createChat = async (agent: AgentId) => {
		const conversation = CONVERSATIONS.find(item => item.agent === agent)!;
		const id = conversation.workspace;
		const cwd = projects[id];
		const workflow = new WorkflowController(createLearningSession(cwd));
		// Pi persists the workflow into the session file on every change; project progress reads it after restarts.
		// Like Pi's SessionManager, append synchronously: unordered async appends can leave an older state last.
		workflow.onChange(() => { appendFileSync(sessionFile(agent), `${JSON.stringify({ type: "custom", customType: "pi-student-workflow", data: workflow.state })}\n`); });
		const controls = capabilityState(workflow);
		const handlers = new Map<string, Handler[]>();
		let activeTools = ["read", "write", "edit", "bash"];
		const notices: string[] = [];
		const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
			registerCommand: () => {}, getActiveTools: () => activeTools, setActiveTools: (tools: string[]) => { activeTools = tools; } };
		const sandbox = { getWorkspacePath: () => cwd, isRunning: () => true,
			fileExists: async (file: string) => access(path.resolve(cwd, file)).then(() => true, () => false), setInternetAllowed: () => {} } as unknown as SandboxRuntime;
		if (options.policy) controls.select(options.policy);
		const capabilities = async (observed: StudentCapabilityInputs = {}) => resolveStudentCapabilities(await context(cwd), { usage: controls, ...observed,
			models: [`${model.provider}/${model.id}`] });
		const activity = createWorkspaceActivity(workflow, sandbox, { stream: new WorkspaceEventStream({ journal }), contextStore: { read: async () => ({}), write: async () => {} },
			capabilities, identity: async () => ({ sessionId: conversation.session }) });
		createProjectCapabilitiesExtension(controls, sandbox)(pi as never);
		activity.extension(pi as never);
		const fire = async (name: string, data: Record<string, unknown> = {}) => {
			let event = { type: name, ...data }, result: any;
			for (const handler of handlers.get(name) ?? []) {
				const value = await handler(event, { cwd, ui: { notify: (message: string) => notices.push(message) }, abort: async () => {} });
				if (value) { result = value; if (value.systemPrompt) event = { ...event, systemPrompt: value.systemPrompt }; if (value.block) break; }
			}
			return result;
		};
		await fire("session_start");
		/** One Chat turn: the context Pi Student adds for the model, then the assistant's reply. */
		const turn = async (reply: { stopReason?: string } = {}) => {
			const prompt = (await fire("before_agent_start", { systemPrompt: "BASE" }))?.systemPrompt ?? "BASE";
			await fire("message_end", { message: { role: "assistant", content: [], usage: { totalTokens: 10, cost: { total: 0 } }, ...reply } });
			await journal.flush();
			return String(prompt).replace(/^BASE\n*/, "");
		};
		return { workflow, controls, fire, turn, notices, activity };
	};
	/** The Chat of a workspace's main conversation, or of a specific conversation. */
	const chat = async (target: WorkspaceId | AgentId) => {
		const agent = (target in AGENTS ? AGENTS[target as WorkspaceId] : target) as AgentId;
		if (!chats.has(agent)) chats.set(agent, await createChat(agent));
		return chats.get(agent)!;
	};

	// The shell server stands in for Paseo's web server and daemon file/terminal APIs.
	const bundle = await build({ entryPoints: [path.join(here, "shell.ts")], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022", logLevel: "silent" });
	const shellCode = bundle.outputFiles[0]!.text;
	let bridgePort = 0;
	const page = () => `<!doctype html><html><head><meta charset="utf-8"><title>Pi Student</title>
<style>body{margin:0;font:14px system-ui;background:#1b1d1e;color:#eee}#layout{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px}pre{white-space:pre-wrap;margin:0}.cm-editor{min-height:120px;background:#111}#menu{position:absolute;background:#333;padding:4px}</style>
${editorCompletionUiScript(bridgePort)}${terminalActivityUiScript(bridgePort)}</head>
<body data-agents='${JSON.stringify(AGENTS)}'>
<div data-testid="sidebar-view"></div>
<div data-testid="workspace-header-title" id="workspace-title"></div>
<div data-testid="workspace-tabs-row"><button data-testid="workspace-tab-chat" id="chat-tab">Chat</button><div><button data-testid="workspace-new-tab-button" id="new-tab">+</button></div></div>
<div id="menu" data-menu-surface hidden><div aria-label="Menu backdrop" id="menu-backdrop"></div><div data-testid="workspace-new-tab-menu-terminal" role="menuitem"><div dir="auto">Terminal</div><span>⌘T</span></div></div>
<div id="layout">
  <section id="chat"><div id="chat-transcript"></div><div data-testid="message-input-root"><textarea id="chat-input"></textarea></div><button id="chat-send">Send</button></section>
  <section><div id="editor-file"></div><div id="editor"></div>
    <form id="terminal-form"><input id="terminal-command" autocomplete="off"><button>Run</button></form><div id="terminal-status"></div><pre id="terminal-output"></pre></section>
</div>
<script>${shellCode.replace(/<\/script/gi, "<\\/script")}</script>
${projectProgressUiScript(bridgePort)}${flowchartUiScript(bridgePort)}
</body></html>`;
	const project = (url: URL) => {
		const id = url.searchParams.get("workspace");
		if (!id || !(id in projects)) throw new Error("unknown workspace");
		return id as WorkspaceId;
	};
	const shell: Server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname.startsWith("/workspace/")) { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page()); return; }
			if (url.pathname === "/harness/file" && url.searchParams.get("file") === "score.js") {
				const file = path.join(projects[project(url)], "score.js");
				if (request.method === "PUT") { await writeFile(file, await body(request)); response.writeHead(204).end(); return; }
				response.writeHead(200, { "Content-Type": "text/plain" }).end(await readFile(file, "utf8")); return;
			}
			if (url.pathname === "/harness/run" && request.method === "POST") {
				if (await body(request) !== "npm test") { response.writeHead(400).end(); return; }
				const npm = process.platform === "win32" ? "npm.cmd" : "npm";
				const result = await run(npm, ["test", "--silent"], { cwd: projects[project(url)] }).then(output => ({ exitCode: 0, output: output.stdout + output.stderr }),
					(error: { code: number; stdout: string; stderr: string }) => ({ exitCode: typeof error.code === "number" ? error.code : 1, output: `${error.stdout}${error.stderr}` }));
				response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result)); return;
			}
			if (url.pathname === "/harness/chat" && request.method === "POST") {
				await body(request);
				const id = project(url), agent = url.searchParams.get("agent");
				const conversation = CONVERSATIONS.find(item => item.agent === agent && item.workspace === id);
				if (!conversation) { response.writeHead(400).end(); return; }
				response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(await (await chat(conversation.agent)).turn()); return;
			}
			response.writeHead(404).end();
		} catch (error) { response.writeHead(500).end(String(error)); }
	});
	await new Promise<void>(resolve => shell.listen(0, "127.0.0.1", resolve));
	const shellOrigin = `http://127.0.0.1:${(shell.address() as AddressInfo).port}`;

	let bridge: Server | undefined;
	/** Starts (or restarts, as after a reload of the whole app) the real ecosystem bridge. */
	const startBridge = async () => {
		if (bridge) { bridge.closeAllConnections(); await new Promise<void>(resolve => bridge!.close(() => resolve())); }
		bridge = createEcosystemBridgeServer(projects.wks_a, paseoHome, { guiOrigin: shellOrigin,
			resolveModelExecution: async cwd => ({ runtime, context: await context(cwd) }) });
		// A fresh port, like a new app launch; pages pick it up when they reload.
		await new Promise<void>((resolve, reject) => { bridge!.once("error", reject); bridge!.listen(0, "127.0.0.1", () => resolve()); });
		bridgePort = (bridge.address() as AddressInfo).port;
	};
	await startBridge();
	const bridgeUrl = () => `http://127.0.0.1:${bridgePort}`;
	/** The GUI's snapshot request for a workspace, following its main conversation, another conversation, or none. */
	const snapshot = async (id: WorkspaceId, agent: AgentId | false = AGENTS[id] as AgentId, query = "") =>
		(await fetch(`${bridgeUrl()}/workspace-snapshot?workspaceId=${id}${agent ? `&agentId=${agent}` : ""}${query}`)).json();

	return {
		root, projects, paseoHome, shellOrigin, bridgeUrl, chat, snapshot, startBridge, modelRequests, journal, sessionFile,
		outage: (value: boolean) => { state.outage = value; },
		async close() {
			for (const item of chats.values()) await item.fire("session_shutdown");
			await journal.flush();
			// Pages may still hold snapshot long-polls open.
			shell.closeAllConnections(); bridge?.closeAllConnections();
			await new Promise<void>(resolve => shell.close(() => resolve()));
			if (bridge) await new Promise<void>(resolve => bridge!.close(() => resolve()));
			if (previousHome === undefined) delete process.env.PI_STUDENT_HOME; else process.env.PI_STUDENT_HOME = previousHome;
			await rm(root, { recursive: true, force: true });
		},
	};
}
