import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, access } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { EffectivePolicy, NextAvailableAction } from "@pi-student/contracts";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";
import { CURRENT_WORK_TOPIC } from "@pi-student/education/extension";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import { resolveEffectivePolicy } from "@pi-student/policy/resolution";
import { FileTeacherContextStore } from "@pi-student/telemetry/local-store";
import { resolveExecutionContext } from "@pi-student/runtime/execution-context";
import { createStudentWorkspace, resolveStudentCapabilities, type StudentCapabilityInputs } from "@pi-student/runtime/student-workspace";
import { createWorkspaceActivity } from "@pi-student/runtime/workspace-activity";
import { WorkspaceEventJournal, WorkspaceEventStream } from "@pi-student/runtime/workspace-events";
import { createProjectCapabilitiesExtension } from "@pi-student/runtime/project-capabilities";
import { describeAssistanceFallback, resolveNextAvailableActions } from "@pi-student/runtime/assistance";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import { createEcosystemBridgeServer } from "../src/ecosystem-bridge.js";

const run = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

/**
 * Real files, subprocess tests, HTTP bridge, disk-backed teacher selection and two
 * independent event streams. Only the external model/identity/policy services and
 * Pi's extension dispatcher are controlled here; no workspace logic is mocked.
 */
async function journey(policy?: EffectivePolicy) {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-journey-")));
	const previousHome = process.env.PI_STUDENT_HOME;
	process.env.PI_STUDENT_HOME = path.join(root, "home");
	cleanup.push(async () => {
		if (previousHome === undefined) delete process.env.PI_STUDENT_HOME; else process.env.PI_STUDENT_HOME = previousHome;
		await rm(root, { recursive: true, force: true });
	});
	const paseoHome = path.join(root, "paseo");
	const projects = { a: path.join(root, "project-a"), b: path.join(root, "project-b") };
	await mkdir(path.join(paseoHome, "projects"), { recursive: true });
	await writeFile(path.join(paseoHome, "projects", "workspaces.json"), JSON.stringify(
		Object.entries(projects).map(([id, cwd]) => ({ workspaceId: `wks_${id}`, cwd }))));
	for (const cwd of Object.values(projects)) {
		await mkdir(cwd);
		await writeFile(path.join(cwd, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node test.mjs" } }));
		await writeFile(path.join(cwd, "score.js"), "export function score() { return 0; }\n");
		await writeFile(path.join(cwd, "test.mjs"), "import { score } from './score.js';\nif (score() !== 2) { console.error('FAIL score.test.js > awards two points\\nAssertionError: expected score to equal 2'); process.exitCode = 1; }\n");
	}
	const selection = new FileTeacherContextStore();
	if (policy) await selection.write({ workspacePath: projects.a, projectId: policy.projectId, classId: "class-a", organizationId: "school" });
	// Resolve the persisted selection for each request, as production does.
	const context = async (cwd: string) => resolveExecutionContext({ workspacePath: cwd, selection: await selection.read(),
		identityProvider: { getIdentity: async () => ({ kind: "student", userId: "student" }) },
		policyProvider: { resolvePolicy: async () => policy },
		scopeProvider: { resolve: async projectId => ({ projectId, classId: "class-a", organizationId: "school", userId: "student" }) },
		environmentProvider: { resolve: async () => ({ sandbox: { mode: "gondolin" }, skills: [], mcps: [] }) },
	});
	const model = { provider: "school", id: "reasoner", name: "Reasoner", reasoning: false, cost: { input: 0, output: 0 } };
	let outage = false, configured = true;
	const modelRequests: unknown[] = [];
	const runtime = {
		getAvailable: async () => [model], getProviderAuthStatus: () => ({ configured }),
		completeSimple: async (_model: unknown, request: { systemPrompt: string }) => {
			modelRequests.push(request);
			if (outage) throw new Error("503 provider unavailable");
			const text = request.systemPrompt.startsWith("Complete code") ? "2" : JSON.stringify({ title: "Score flow", summary: "Award points", nodes: [
				{ id: "score", label: "Award points", type: "action", file: "score.js", symbol: "score" },
			], edges: [] });
			return { stopReason: "stop", content: [{ type: "text", text }] };
		},
	} as unknown as ModelRuntime;
	const server = createEcosystemBridgeServer(projects.a, paseoHome, { resolveModelExecution: async cwd => ({ runtime, context: await context(cwd) }) });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const request = async (endpoint: string, body?: object, project = "a") => {
		const response = await fetch(`${base}/${endpoint}${endpoint.includes("?") ? "&" : "?"}workspaceId=wks_${project}`, body === undefined ? undefined : {
			method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" }, body: JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() };
	};
	const report = async (event: object, project = "a") => expect((await request("workspace-events", event, project)).status).toBe(202);
	const journal = new WorkspaceEventJournal();
	cleanup.push(() => journal.flush());
	const chat = async (project: "a" | "b" = "a") => {
		const cwd = projects[project];
		const workflow = new WorkflowController(createLearningSession(cwd));
		const controls = capabilityState(workflow);
		controls.select((await context(cwd)).policy);
		let observed: StudentCapabilityInputs = {};
		let activeTools = ["read", "write", "edit", "bash"];
		const notices: string[] = [];
		const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any>>>();
		const pi = { on: (name: string, handler: any) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
			registerCommand: () => {}, getActiveTools: () => activeTools, setActiveTools: (tools: string[]) => { activeTools = tools; } };
		const sandbox = { getWorkspacePath: () => cwd, isRunning: () => true,
			fileExists: async (file: string) => access(path.resolve(cwd, file)).then(() => true, () => false), setInternetAllowed: () => {} } as unknown as SandboxRuntime;
		const capabilities = async (extra: StudentCapabilityInputs = {}) => resolveStudentCapabilities(await context(cwd), { usage: controls, ...observed, ...extra });
		const activity = createWorkspaceActivity(workflow, sandbox, { stream: new WorkspaceEventStream({ journal }), contextStore: selection, capabilities });
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
		cleanup.push(async () => { await fire("session_shutdown"); await journal.flush(); });
		const prompt = async () => (await fire("before_agent_start", { systemPrompt: "Tutor the student." }))?.systemPrompt ?? "Tutor the student.";
		const edit = async (content: string) => {
			const call = { toolName: "edit", toolCallId: "edit-score", input: { path: path.join(cwd, "score.js") } };
			const permission = await fire("tool_call", call);
			if (permission?.block) return permission;
			await writeFile(path.join(cwd, "score.js"), content);
			await fire("tool_result", { ...call, isError: false, content: [] });
		};
		const workspace = async () => createStudentWorkspace(await context(cwd), { capabilities: await capabilities(),
			learning: { stage: workflow.getStage(), learnMode: workflow.state.learnMode === true }, ui: activity.stream.ui(activity.scope()!) });
		return { fire, prompt, edit, workflow, controls, activity, notices, capabilities, workspace,
			observe: (value: StudentCapabilityInputs) => { observed = value; }, activeTools: () => activeTools };
	};
	const test = async (actor: "student" | Awaited<ReturnType<typeof chat>>, project: "a" | "b" = "a") => {
		const call = { toolName: "bash", toolCallId: "test-score", input: { command: "npm test" } };
		if (actor !== "student") expect(await actor.fire("tool_call", call)).toBeUndefined();
		const result = await run(process.execPath, ["test.mjs"], { cwd: projects[project] })
			.then(output => ({ exitCode: 0, output: output.stdout + output.stderr }),
				(error: { code: number; stdout: string; stderr: string }) => ({ exitCode: error.code, output: error.stdout + error.stderr }));
		if (actor === "student") await report({ type: "terminal.command_finished", command: "npm test", exitCode: result.exitCode, summary: result.output }, project);
		else await actor.fire("tool_result", { ...call, isError: result.exitCode !== 0, content: [{ type: "text", text: `${result.output}\nCommand exited with code ${result.exitCode}` }] });
		return result.exitCode;
	};
	const map = async () => { const response = await request("flowchart", {}); expect(response.status).toBe(200); return response.body; };
	return { root, projects, selection, context, chat, request, report, test, map, journal, modelRequests,
		outage: () => { outage = true; }, disconnect: () => { configured = false; } };
}

const workingCode = "export function score() { return 2; }\n";
const available = (actions: NextAvailableAction[], name: string) => actions.find(action => action.action === name)?.available;
const managedPolicy = (settings = {}) => resolveEffectivePolicy({ projectId: "project-a", delegatedPaths: ["fileEditing", "terminal", "limits.turns"],
	organization: { scope: "organization", version: 1, settings: { models: ["school/reasoner"], internet: false } },
	class: { scope: "class", version: 2, settings: { terminal: false } }, project: { scope: "project", version: 3, settings } });

describe("student journeys across the workspace", () => {
	it("A: open → inspect map → Chat → plan → agent edit → test → review", async () => {
		const h = await journey();
		const chat = await h.chat();
		const graph = await h.map();
		await h.report({ ...graph.nodes[0], type: "flowchart.node_selected" });
		expect(await chat.prompt()).toContain('Selected node: "Award points"');
		chat.workflow.updateLearningState({ currentStage: "understand", goalSummary: "Award two points", understandingReady: true, readyForNextStage: true });
		chat.workflow.addStudentPlanStep("Return two points from score");
		chat.workflow.approveStudentPlan("I will check the result with the score test");
		chat.workflow.updateLearningState({ currentStage: "plan", planSummary: "Change scoring and verify", readyForNextStage: true });
		expect(chat.workflow.canUseTool("edit")).toBe(true);
		expect(await chat.edit(workingCode)).toBeUndefined();
		expect(await h.test(chat)).toBe(0);
		chat.workflow.updateLearningState({ currentStage: "implement", readyForNextStage: true });
		expect(chat.workflow.getStage()).toBe("review");
		const workspace = await chat.workspace();
		expect(workspace.ui.recentChanges).toContainEqual(expect.objectContaining({ file: "score.js", author: "agent" }));
		expect(workspace.ui.tests?.lastRun).toMatchObject({ passed: true, actor: "agent" });
		expect(workspace.ui.flowchart?.stale).toBe(true);
		expect(await readFile(path.join(h.projects.a, "score.js"), "utf8")).toBe(workingCode);
	});

	it("B: agent edit → manual edit → failed test → concise Chat awareness", async () => {
		const h = await journey(); const chat = await h.chat();
		await chat.prompt(); await chat.edit(workingCode);
		await h.report({ type: "file.opened", file: "score.js" });
		await writeFile(path.join(h.projects.a, "score.js"), "export function score() { return 3; }\n");
		await h.report({ type: "file.changed", file: "score.js", content: "MUST_NOT_ENTER_AI_CONTEXT" });
		expect(await h.test("student")).toBe(1);
		const prompt = await chat.prompt();
		expect(prompt).toContain("Student modified (typed themselves):\n- score.js");
		expect(prompt).toContain("You (the assistant) modified:\n- score.js");
		expect(prompt).toContain("score.test.js > awards two points failed");
		expect(prompt).toContain("run by the student, exit 1");
		expect(prompt).not.toMatch(/MUST_NOT_ENTER_AI_CONTEXT|return 3/);
		expect(prompt.length).toBeLessThan(2000);
		expect(await chat.prompt()).not.toContain("Since the previous AI turn");
	});

	it("C: agent budget closes execution while tutoring, completion and manual work continue", async () => {
		const policy = resolveEffectivePolicy({ projectId: "project-a", delegatedPaths: [], organization: { scope: "organization", version: 1,
			settings: { models: ["school/reasoner"], limits: { turns: 1, tutoringTurns: 3 } } } });
		const h = await journey(policy); const chat = await h.chat();
		await chat.prompt();
		await chat.fire("message_end", { message: { role: "assistant", content: [], usage: { totalTokens: 10, cost: { total: 0 } } } });
		expect(await chat.edit(workingCode)).toMatchObject({ block: true });
		expect(await chat.prompt()).toContain("Tutoring mode");
		expect(chat.activeTools()).toEqual([]);
		const actions = resolveNextAvailableActions(await chat.workspace());
		for (const action of ["ask-guidance", "open-editor", "autocomplete", "use-terminal", "run-tests"]) expect(available(actions, action)).toBe(true);
		expect(available(actions, "agent-edit")).toBe(false);
		const completion = await h.request("editor-completion", { filename: "score.js", content: "return ", cursor: 7, model: "auto" });
		expect(completion.status).toBe(200); expect(completion.body.suggestion).toBe("2");
		await writeFile(path.join(h.projects.a, "score.js"), workingCode);
		await h.report({ type: "autocomplete.accepted", file: "score.js" });
		expect(await h.test("student")).toBe(0);
		expect(await chat.prompt()).toContain("Student accepted AI autocomplete suggestions in");
	});

	it("D: a reasoning-only model recommends manual work and keeps tutoring", async () => {
		const h = await journey(); const chat = await h.chat();
		chat.observe({ model: { available: true, toolUse: false } });
		const workspace = await chat.workspace();
		expect(workspace.capabilities.chat.allowed).toBe(true);
		expect(workspace.capabilities.agentFileEditing).toMatchObject({ allowed: false, code: "model_cannot_use_tools" });
		const fallback = describeAssistanceFallback(resolveNextAvailableActions(workspace));
		expect(fallback?.hint).toBe("Open the relevant file and continue manually.");
		expect(fallback?.canStill).toContain("ask for guidance");
		expect(await chat.prompt()).toContain("Explain the change and let the student make it in the editor");
	});

	it("E: Learn → Flowchart → source → manual edit → /question about current work", async () => {
		const h = await journey(); const chat = await h.chat();
		chat.workflow.setLearnMode(true);
		await h.journal.flush();
		expect((await h.request("workspace-activity")).body.scaffolding.enabled).toBe(true);
		const graph = await h.map(); const node = graph.nodes[0];
		await h.report({ ...node, type: "flowchart.node_selected" });
		await h.report({ type: "file.opened", file: node.file });
		await h.report({ type: "editor.selection_changed", file: node.file, startLine: node.line, endLine: node.line });
		await writeFile(path.join(h.projects.a, node.file), workingCode);
		await h.report({ type: "file.changed", file: node.file });
		chat.workflow.setQuestion({ difficulty: "medium", topic: CURRENT_WORK_TOPIC, phase: "generate" });
		const prompt = await chat.prompt();
		expect(prompt).toContain("Student-authored changes (typed themselves, most recent first):\n- score.js");
		expect(prompt).toContain('Selected Flowchart component: "Award points"');
		expect(prompt).toContain("Selected code: score.js lines 1-1");
		expect(prompt).not.toContain("Workspace context (metadata only");
		expect(chat.workflow.canUseTool("edit")).toBe(false);
	});

	it("F: organization → teacher/project → context → capabilities → surfaces enforce one policy", async () => {
		const h = await journey(managedPolicy({ fileEditing: false })); const chat = await h.chat();
		const context = await h.context(h.projects.a);
		expect(context.policy?.provenance).toMatchObject({ internet: { scope: "organization" }, terminal: { scope: "class" }, fileEditing: { scope: "project" } });
		const workspace = await chat.workspace();
		const gui = (await h.request("workspace-actions")).body.actions;
		expect(gui).toEqual(resolveNextAvailableActions(workspace));
		for (const action of ["agent-edit", "agent-run-command", "autocomplete", "use-internet"]) expect(available(gui, action)).toBe(false);
		expect(await chat.edit(workingCode)).toMatchObject({ block: true });
		expect(await chat.fire("tool_call", { toolName: "bash", input: { command: "npm test" } })).toMatchObject({ block: true });
		expect((await h.request("editor-completion/models")).body.models).toEqual([]);
		expect((await h.request("editor-completion", { filename: "score.js", content: "return ", cursor: 7, model: "auto" })).status).toBe(403);
		expect(await chat.prompt()).toContain("agent_editing_disabled");
		for (const action of ["ask-guidance", "open-editor", "use-terminal", "run-tests", "generate-map"]) expect(available(gui, action)).toBe(true);
		expect((await h.map()).nodes).toHaveLength(1);
	});

	it("G: switch projects without editor, event, test, map, teacher or AI context leakage", async () => {
		const h = await journey(managedPolicy()); const a = await h.chat();
		await h.map();
		await h.report({ type: "flowchart.node_selected", id: "a", label: "A private learning focus", file: "score.js" });
		await h.report({ type: "editor.selection_changed", file: "score.js", startLine: 1, endLine: 1 });
		await h.report({ type: "file.changed", file: "score.js" });
		await h.test("student"); await a.prompt(); await h.journal.flush();
		const bUi = (await h.request("workspace-activity", undefined, "b")).body;
		expect(bUi).toMatchObject({ openFiles: [], recentChanges: [] });
		for (const key of ["activeFile", "selectedCode", "terminal", "tests", "flowchart"]) expect(bUi[key]).toBeUndefined();
		// A stale teacher selection must fail closed rather than supply A's context to B.
		await expect(h.context(h.projects.b)).rejects.toThrow("another workspace");
		await h.selection.write({});
		const b = await h.chat("b");
		const workspace = await b.workspace();
		expect(workspace.scope.projectId).toBeUndefined(); expect(workspace.scope.organizationId).toBeUndefined();
		expect(b.activity.stream.events(b.activity.scope()!)).toEqual([]);
		expect(await b.prompt()).not.toMatch(/A private|score.js|score.test|school|Project capability settings/);
		await writeFile(path.join(h.projects.b, "score.js"), workingCode);
		await h.report({ type: "file.changed", file: "score.js" }, "b");
		expect(await h.test("student", "b")).toBe(0);
		expect(await readFile(path.join(h.projects.a, "score.js"), "utf8")).not.toBe(workingCode);
	});

	it("H: provider outage preserves code, terminal and an existing map with useful guidance", async () => {
		const h = await journey(); const chat = await h.chat();
		const graph = await h.map();
		h.outage();
		const failed = await h.request("flowchart", {});
		expect(failed.status).toBe(502);
		for (const action of ["open-editor", "use-terminal", "run-tests", "view-map"]) expect(available(failed.body.actions, action)).toBe(true);
		expect(available(failed.body.actions, "ask-guidance")).toBe(false);
		expect(failed.body.fallback.canStill).toContain("edit the code yourself");
		expect(graph.nodes[0].label).toBe("Award points");
		expect((await h.request("workspace-activity")).body.flowchart.generatedAt).toBeTruthy();
		await chat.fire("message_end", { message: { role: "assistant", stopReason: "error", content: [], usage: { totalTokens: 0, cost: { total: 0 } } } });
		expect(chat.notices.at(-1)).toContain("The AI model is unavailable right now");
		await writeFile(path.join(h.projects.a, "score.js"), workingCode);
		await h.report({ type: "file.changed", file: "score.js" });
		expect(await h.test("student")).toBe(0);
	});

	it("does not advertise AI actions when the provider has no configured model", async () => {
		const h = await journey(); h.disconnect();
		const { actions } = (await h.request("workspace-actions")).body;
		expect(available(actions, "ask-guidance")).toBe(false);
		expect(available(actions, "open-editor")).toBe(true);
		expect((await h.request("editor-completion/models")).body.models).toEqual([]);
	});
});
