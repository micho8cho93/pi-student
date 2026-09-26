import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EffectivePolicy } from "@pi-student/contracts";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { resolveStudentCapabilities, unavailableStudentCapabilities } from "../src/student-workspace.js";
import { createWorkspaceActivity } from "../src/workspace-activity.js";
import { buildStudentWorkspaceSnapshot, learningProgress, sessionCapabilitySignals } from "../src/workspace-snapshot.js";
import { WorkspaceMapStore } from "../src/workspace-map-store.js";
import { STUDENT_SURFACE_EVENTS, visibleToSession, workspaceEventKey, WorkspaceEventJournal, WorkspaceEventStream } from "../src/workspace-events.js";

const roots: string[] = [];
const journals: WorkspaceEventJournal[] = [];
afterEach(async () => {
	await Promise.all(journals.splice(0).map(journal => journal.flush()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function directory(prefix = "pi-sessions-") {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
	roots.push(root);
	return root;
}
async function journal() {
	const value = new WorkspaceEventJournal(await directory("pi-sessions-journal-"));
	journals.push(value);
	return value;
}

type Handler = (event: any, ctx?: any) => Promise<any>;
/** One Chat session bound to `sessionId` in `project`, sharing the journal with every other process. */
async function chat(project: string, shared: WorkspaceEventJournal, identity: { sessionId?: string; userId?: string }, policy?: EffectivePolicy) {
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
	const notices: string[] = [];
	const fire = async (name: string, event: object = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, { ui: { notify: (message: string) => notices.push(message) } }) ?? result;
		return result;
	};
	const workflow = new WorkflowController(createLearningSession(project));
	if (policy) capabilityState(workflow).select(policy);
	const sandbox = { getWorkspacePath: () => "/workspace", fileExists: async () => true } as never;
	let current = identity;
	const activity = createWorkspaceActivity(workflow, sandbox, { stream: new WorkspaceEventStream({ journal: shared }),
		contextStore: { read: async () => ({}), write: async () => {} }, identity: async () => current });
	activity.extension(pi as never);
	await fire("session_start");
	const prompt = async () => { const value = (await fire("before_agent_start", { systemPrompt: "base" }))?.systemPrompt as string | undefined; await shared.flush(); return value; };
	const reply = async (message: object = {}) => { await fire("message_end", { message: { role: "assistant", stopReason: "stop", ...message } }); await shared.flush(); };
	return { fire, prompt, reply, workflow, activity, notices, rebind: (next: typeof identity) => { current = next; } };
}

describe("two Chat sessions in one project", () => {
	it("share project activity but never Learn, prompt windows, model health, budget or progress", async () => {
		const project = await directory();
		const shared = await journal();
		const limited: EffectivePolicy = { projectId: "p", version: 1, sourceVersions: {}, settings: { ...DEFAULT_CAPABILITY_POLICY, limits: { ...DEFAULT_CAPABILITY_POLICY.limits, turns: 1 } } };
		const one = await chat(project, shared, { sessionId: "session-one" }, limited);
		const two = await chat(project, shared, { sessionId: "session-two" });
		const gui = new WorkspaceEventStream({ journal: shared });
		const scope = (sessionId?: string) => ({ projectPath: project, ...(sessionId ? { sessionId } : {}) });
		// Session two has an AI turn first, so its "since the previous AI turn" window starts here.
		await two.prompt();

		// Project-scoped: a student edit and test run reach both sessions.
		gui.emit(scope(), "editor", { type: "file.changed", file: "src/app.ts" }, STUDENT_SURFACE_EVENTS);
		gui.emit(scope(), "terminal", { type: "test.failed", command: "npm test", exitCode: 1, summary: "FAIL src/app.test.ts > renders" });
		await shared.flush();

		// Session-scoped: one turns Learn on, advances its plan, fails a reply and exhausts its budget.
		one.workflow.setLearnMode(true);
		one.workflow.updateLearningState({ currentStage: "understand", goalSummary: "Render the list", understandingReady: true, readyForNextStage: true });
		const first = (await one.prompt())!;
		capabilityState(one.workflow).turns = 1;
		await one.reply({ stopReason: "error", errorMessage: "503 provider unavailable" });

		const second = (await two.prompt())!;
		expect(first).toContain("Student modified (typed themselves):\n- src/app.ts");
		expect(second).toContain("Student modified (typed themselves):\n- src/app.ts");
		expect(second).toContain("src/app.test.ts > renders failed");
		// Session one's later prompt did not end session two's window.
		expect(second).toContain("Since the previous AI turn:\nStudent modified (typed themselves):\n- src/app.ts");

		await gui.refresh(scope("session-one"));
		await gui.refresh(scope("session-two"));
		await gui.refresh(scope());
		expect(gui.session(scope("session-one"))).toMatchObject({ learn: { enabled: true }, model: { available: false }, budget: { exhausted: { lane: "agent" } },
			progress: { stage: "plan", goal: "Render the list", understandingReady: true } });
		expect(gui.session(scope("session-two"))).toMatchObject({ learn: { enabled: false }, progress: { stage: "understand", understandingReady: false } });
		expect(gui.session(scope("session-two"))).not.toHaveProperty("budget");
		expect(gui.session(scope("session-two"))).not.toHaveProperty("model.available");
		expect(gui.ui(scope("session-one")).learn?.enabled).toBe(true);
		expect(gui.ui(scope("session-two")).learn?.enabled).toBe(false);
		// A surface bound to no Chat sees project state only.
		expect(gui.ui(scope()).learn).toBeUndefined();
		expect(gui.ui(scope()).tests?.lastRun?.passed).toBe(false);
		expect(gui.events(scope("session-two")).filter(event => event.type === "budget.exhausted")).toEqual([]);

		// The GUI-facing capability projection agrees, per session.
		const capabilities = (sessionId: string) => resolveStudentCapabilities({ identity: { kind: "personal" }, workspacePath: project, sandbox: { mode: "gondolin" } },
			{ ...sessionCapabilitySignals(gui.session(scope(sessionId))), models: ["local/tutor"] });
		expect(capabilities("session-one").chat).toMatchObject({ allowed: false, code: "provider_unavailable" });
		expect(capabilities("session-two").chat.allowed).toBe(true);
		expect(capabilities("session-two").agentFileEditing.allowed).toBe(true);
	});

	it("drops a delayed tool result and every transient state when the Chat is bound to another session", async () => {
		const project = await directory();
		const shared = await journal();
		const one = await chat(project, shared, { sessionId: "session-one" });
		await one.fire("tool_call", { toolName: "edit", toolCallId: "late", input: { path: "/workspace/src/app.ts" } });
		one.rebind({ sessionId: "session-two" });
		await one.prompt();
		// The result of a call started in the previous session arrives after the switch.
		await one.fire("tool_result", { toolName: "edit", toolCallId: "late", isError: false, content: [] });
		const scope = one.activity.scope()!;
		expect(scope.sessionId).toBe("session-two");
		expect(one.activity.stream.ui(scope).recentChanges).toEqual([]);
		expect(one.activity.stream.events(scope).map(event => event.type)).not.toContain("agent.files_changed");
	});
});

describe("project switch", () => {
	it("does not turn a tool result from the previous project into activity of the new one", async () => {
		const project = await directory();
		const shared = await journal();
		let selection = {};
		const handlers = new Map<string, Handler[]>();
		const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
		const fire = async (name: string, event: object = {}) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, { ui: { notify: () => {} } }); };
		const activity = createWorkspaceActivity(new WorkflowController(createLearningSession(project)), { getWorkspacePath: () => "/workspace", fileExists: async () => true } as never,
			{ stream: new WorkspaceEventStream({ journal: shared }), contextStore: { read: async () => selection, write: async () => {} }, identity: async () => ({ userId: "student", sessionId: "s" }) });
		activity.extension(pi as never);
		await fire("session_start");
		const personal = activity.scope()!;
		await fire("tool_call", { toolName: "bash", toolCallId: "slow", input: { command: "npm test" } });
		await fire("tool_call", { toolName: "write", toolCallId: "slow-write", input: { path: "/workspace/src/a.ts" } });
		// The student selects a class project for this workspace while the agent's tools are still running.
		selection = { projectId: "class-project", organizationId: "org", workspacePath: project };
		await fire("before_agent_start", { systemPrompt: "base" });
		const classScope = activity.scope()!;
		expect(classScope.projectId).toBe("class-project");
		await fire("tool_result", { toolName: "bash", toolCallId: "slow", isError: true, content: [{ type: "text", text: "FAIL a.test.ts\nCommand exited with code 1" }] });
		await fire("tool_result", { toolName: "write", toolCallId: "slow-write", isError: false, content: [] });
		const types = activity.stream.events(classScope).map(event => event.type);
		for (const type of ["agent.files_changed", "test.failed", "terminal.command_finished"]) expect(types).not.toContain(type);
		expect(activity.stream.ui(classScope)).toMatchObject({ recentChanges: [] });
		expect(activity.stream.ui(classScope).tests).toBeUndefined();
		await shared.flush();
		const gui = new WorkspaceEventStream({ journal: shared });
		await gui.refresh(classScope);
		expect(gui.ui(classScope).tests).toBeUndefined();
	});
});

describe("students and stale journal entries", () => {
	it("keys activity by student, so two students in the same project never see each other's work", async () => {
		const project = await directory();
		const shared = await journal();
		const alice = await chat(project, shared, { userId: "alice", sessionId: "s1" });
		const bob = await chat(project, shared, { userId: "bob", sessionId: "s1" });
		expect(workspaceEventKey({ projectPath: project, userId: "alice" })).not.toBe(workspaceEventKey({ projectPath: project, userId: "bob" }));
		// A signed-out (personal) workspace keeps the key it had before students were part of the key.
		expect(workspaceEventKey({ projectPath: project })).toBe(workspaceEventKey({ projectPath: project, sessionId: "any" }));
		const gui = new WorkspaceEventStream({ journal: shared });
		gui.emit({ projectPath: project, userId: "alice" }, "editor", { type: "file.changed", file: "alice.ts" }, STUDENT_SURFACE_EVENTS);
		alice.workflow.setLearnMode(true);
		await shared.flush();
		expect(await alice.prompt()).toContain("alice.ts");
		const bobContext = await bob.prompt();
		expect(bobContext ?? "").not.toContain("alice.ts");
		await gui.refresh({ projectPath: project, userId: "bob", sessionId: "s1" });
		expect(gui.session({ projectPath: project, userId: "bob", sessionId: "s1" }).learn?.enabled ?? false).toBe(false);
		expect(new WorkspaceMapStore(await directory()).status({ projectPath: project, userId: "bob" })).resolves.toMatchObject({ available: false });
	});

	it("rejects journal entries that would widen a session event or forge a session on project events", async () => {
		const project = await directory();
		const shared = await journal();
		const scope = { projectPath: project, sessionId: "mine" };
		const key = workspaceEventKey(scope);
		const at = new Date().toISOString();
		const line = (value: object) => appendFile(path.join(shared.directory, `${key}.jsonl`), `${JSON.stringify({ workspace: key, origin: "other", at, source: "chat", ...value })}\n`);
		await new WorkspaceEventStream({ journal: shared }).refresh(scope); // creates nothing; the journal starts empty
		await import("node:fs/promises").then(fs => fs.mkdir(shared.directory, { recursive: true }));
		await line({ seq: 1, type: "learn.enabled", session: "../../mine" });
		await line({ seq: 2, type: "file.changed", file: "src/a.ts", session: "mine" });
		await line({ seq: 3, type: "model.health", available: "no", session: "mine" });
		await line({ seq: 4, type: "learning.progress", stage: "deploy", session: "mine" });
		await line({ seq: 5, type: "learn.enabled", session: "theirs" });
		await line({ seq: 6, type: "budget.exhausted", reason: "Limit", session: "mine", at: new Date(Date.now() - 13 * 3_600_000).toISOString() });
		await line({ seq: 7, type: "model.health", available: false, session: "mine" });
		const stream = new WorkspaceEventStream({ journal: shared });
		await stream.refresh(scope);
		expect(stream.events(scope).map(event => event.type)).toEqual(["model.health"]);
		expect(stream.session(scope)).toEqual({ model: { available: false, at } });
		expect(stream.ui(scope).recentChanges).toEqual([]);
		expect(visibleToSession({ type: "file.changed" }, undefined)).toBe(true);
		expect(visibleToSession({ type: "learn.enabled", session: "a" }, "b")).toBe(false);
	});
});

describe("StudentWorkspaceSnapshot", () => {
	const context = { identity: { kind: "personal" as const }, workspacePath: "/project", sandbox: { mode: "gondolin" as const } };
	const ui = { openFiles: [], recentChanges: [{ file: "src/app.ts", kind: "modified" as const, author: "student" as const, at: "t" }, { file: ".env", kind: "modified" as const, author: "student" as const, at: "t" }],
		tests: { lastRun: { command: "npm test", passed: false, exitCode: 1, summary: "FAIL secret output", failedTests: ["src/app.test.ts"], actor: "student" as const, at: "t" } },
		activeFile: "src/app.ts" };
	const noMap = { available: false, stale: false, staleFiles: [] };

	it("closes agent execution everywhere when Chat's agent budget is exhausted, and keeps tutoring and manual work", () => {
		const session = { budget: { exhausted: { reason: "The AI implementation budget has been reached.", lane: "agent" as const, at: "t" } } };
		const capabilities = resolveStudentCapabilities(context, { ...sessionCapabilitySignals(session), models: ["local/tutor"] });
		const snapshot = buildStudentWorkspaceSnapshot({ workspace: { capabilities, ui }, session, map: noMap });
		const action = (name: string) => snapshot.actions.find(item => item.action === name);
		expect(action("agent-edit")).toMatchObject({ available: false, reason: "agent_budget_exhausted" });
		for (const name of ["ask-guidance", "open-editor", "use-terminal", "run-tests", "autocomplete"]) expect(action(name)?.available).toBe(true);
		expect(snapshot.budget.find(row => row.lane === "agent")?.status).toBe("exhausted");
		expect(snapshot.budget.find(row => row.lane === "manual")?.status).toBe("unrestricted");
		expect(snapshot.fallback?.headline).toContain("implementation budget");
	});

	it("reports a provider outage Chat observed and recovers when Chat does", () => {
		const down = resolveStudentCapabilities(context, { ...sessionCapabilitySignals({ model: { available: false, at: "t" } }), models: ["local/tutor"] });
		const snapshot = buildStudentWorkspaceSnapshot({ workspace: { capabilities: down, ui }, session: {}, map: noMap });
		expect(snapshot.model).toMatchObject({ available: false, reason: "provider_unavailable" });
		expect(snapshot.fallback?.canStill).toContain("edit the code yourself");
		const up = resolveStudentCapabilities(context, { ...sessionCapabilitySignals({ model: { available: true, at: "t" } }), models: ["local/tutor"] });
		expect(buildStudentWorkspaceSnapshot({ workspace: { capabilities: up, ui }, session: {}, map: noMap }).model.available).toBe(true);
	});

	it("distinguishes no configured model and unresolvable controls, and never hides manual surfaces", () => {
		const none = buildStudentWorkspaceSnapshot({ workspace: { capabilities: resolveStudentCapabilities(context, { models: [] }), ui }, session: {}, map: noMap });
		expect(none.model).toEqual({ available: false, reason: "no_model" });
		const down = buildStudentWorkspaceSnapshot({ workspace: { capabilities: unavailableStudentCapabilities("Controls unavailable"), ui }, session: {}, map: noMap });
		for (const snapshot of [none, down]) {
			for (const name of ["open-editor", "use-terminal", "run-tests"]) expect(snapshot.actions.find(item => item.action === name)?.available).toBe(true);
		}
	});

	it("is metadata only and changes revision only when something shown changes", () => {
		const capabilities = resolveStudentCapabilities(context, { models: ["local/tutor"] });
		const map = { available: true, generatedAt: "t", stale: true, staleFiles: ["src/app.ts", ".env"] };
		const snapshot = buildStudentWorkspaceSnapshot({ workspace: { capabilities, ui }, session: {}, map });
		const serialized = JSON.stringify(snapshot);
		for (const hidden of ["secret output", ".env", "/project"]) expect(serialized).not.toContain(hidden);
		expect(snapshot.activity.lastTest).toEqual({ command: "npm test", passed: false, exitCode: 1, failedTests: ["src/app.test.ts"], actor: "student", at: "t" });
		// The persisted map, not the event window, decides whether the map can be viewed.
		expect(snapshot.actions.find(item => item.action === "view-map")?.available).toBe(true);
		expect(buildStudentWorkspaceSnapshot({ workspace: { capabilities, ui }, session: {}, map }).revision).toBe(snapshot.revision);
		expect(buildStudentWorkspaceSnapshot({ workspace: { capabilities, ui }, session: {}, map: { ...map, stale: false, staleFiles: [] } }).revision).not.toBe(snapshot.revision);
	});

	it("prefers the live learning state, then the saved one, then the default", () => {
		const capabilities = resolveStudentCapabilities(context, { models: ["local/tutor"] });
		const workflow = new WorkflowController(createLearningSession("/project"));
		workflow.updateLearningState({ currentStage: "understand", goalSummary: "Use token ghp_abcdefghijklmnopqrstuvwxyz0123", understandingReady: true, readyForNextStage: true });
		const saved = learningProgress(workflow.state);
		expect(saved.goal).not.toContain("ghp_");
		const build = (session: object, savedProgress?: typeof saved) => buildStudentWorkspaceSnapshot({ workspace: { capabilities, ui }, session, savedProgress, map: noMap }).learning;
		expect(build({})).toMatchObject({ stage: "understand", source: "default" });
		expect(build({}, saved)).toMatchObject({ stage: "plan", source: "saved" });
		expect(build({ progress: { ...saved, stage: "implement", at: "t" } }, saved)).toMatchObject({ stage: "implement", source: "live" });
	});
});

describe("persisted workspace map", () => {
	const chart = (nodes: string[]) => ({ title: "Flow", nodes: nodes.map(id => ({ id, label: id.toUpperCase(), file: "src/app.ts" })), edges: [], generatedAt: new Date().toISOString(), filesRead: 1 });

	it("survives restarts, detects stale sources from disk, restores the selection and never crosses projects", async () => {
		const [a, b, home] = [await directory(), await directory(), await directory()];
		await import("node:fs/promises").then(fs => fs.mkdir(path.join(a, "src")));
		await writeFile(path.join(a, "src/app.ts"), "export const a = 1;\n");
		await writeFile(path.join(a, "src/util.ts"), "export const u = 1;\n");
		const store = new WorkspaceMapStore(home);
		const { flowchartSourceDigests } = await import("../src/workspace-map-store.js");
		await store.save({ projectPath: a }, chart(["start", "render"]), await flowchartSourceDigests(a));
		await store.select({ projectPath: a }, "render");
		await store.select({ projectPath: a }, "missing");

		const restarted = new WorkspaceMapStore(home);
		expect(await restarted.status({ projectPath: a })).toMatchObject({ available: true, stale: false, staleFiles: [], selectedNode: { id: "render", label: "RENDER", file: "src/app.ts" } });
		expect(await restarted.status({ projectPath: b })).toEqual({ available: false, stale: false, staleFiles: [] });
		expect(await restarted.status({ projectPath: a, projectId: "class-project" })).toMatchObject({ available: false });

		await writeFile(path.join(a, "src/app.ts"), "export const a = 2;\n");
		await writeFile(path.join(a, "src/new.ts"), "export const n = 1;\n");
		await unlink(path.join(a, "src/util.ts"));
		await writeFile(path.join(a, ".env"), "SECRET=1\n");
		expect(await restarted.status({ projectPath: a })).toMatchObject({ stale: true, staleFiles: ["src/app.ts", "src/new.ts", "src/util.ts"] });

		// Regenerating keeps a selection that still exists; a map file for another workspace is ignored.
		await restarted.save({ projectPath: a }, chart(["render"]), await flowchartSourceDigests(a));
		expect(await restarted.status({ projectPath: a })).toMatchObject({ stale: false, selectedNode: { id: "render" } });
		const file = path.join(home, `${workspaceEventKey({ projectPath: a })}.json`);
		await writeFile(path.join(home, `${workspaceEventKey({ projectPath: b })}.json`), await readFile(file, "utf8"));
		expect(await restarted.status({ projectPath: b })).toMatchObject({ available: false });
		await writeFile(file, "{ not json");
		expect(await restarted.status({ projectPath: a })).toMatchObject({ available: false });
	});
});
