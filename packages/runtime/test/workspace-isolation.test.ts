import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EffectivePolicy, WorkspaceEventType } from "@pi-student/contracts";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { TeacherContext } from "@pi-student/telemetry/types";
import { resolveStudentCapabilities } from "../src/student-workspace.js";
import { createWorkspaceActivity } from "../src/workspace-activity.js";
import { buildStudentWorkspaceSnapshot, sessionCapabilitySignals } from "../src/workspace-snapshot.js";
import { SESSION_SCOPED_EVENTS, STUDENT_SURFACE_EVENTS, workspaceEventKey, WorkspaceEventJournal, WorkspaceEventStream,
	WorkspaceIdentityRequiredError } from "../src/workspace-events.js";

const roots: string[] = [];
const journals: WorkspaceEventJournal[] = [];
afterEach(async () => {
	await Promise.all(journals.splice(0).map(journal => journal.flush()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function directory(prefix = "pi-isolation-") {
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
	roots.push(root);
	return root;
}
async function journal() {
	const value = new WorkspaceEventJournal(await directory("pi-isolation-journal-"));
	journals.push(value);
	return value;
}
const journalFiles = async (shared: WorkspaceEventJournal) => (await readdir(shared.directory).catch(() => [] as string[])).sort();

/** Agent budget: one AI implementation turn. */
const limited: EffectivePolicy = { projectId: "p", version: 1, sourceVersions: {},
	settings: { ...DEFAULT_CAPABILITY_POLICY, limits: { ...DEFAULT_CAPABILITY_POLICY.limits, turns: 1 } } };

type Handler = (event: any, ctx?: any) => Promise<any>;
type Identity = { userId?: string; sessionId?: string };
/**
 * One Chat as the runtime wires it. `identity` stands in for the authenticated
 * control plane: it returns the student it resolved, or throws when lookup fails.
 */
async function chat(project: string, shared: WorkspaceEventJournal, identity: Identity | (() => Identity), options: { selection?: TeacherContext; policy?: EffectivePolicy;
	fileExists?: (file: string) => Promise<boolean> } = {}) {
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
	const fire = async (name: string, event: object = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, { ui: { notify: () => {} } }) ?? result;
		return result;
	};
	const workflow = new WorkflowController(createLearningSession(project));
	if (options.policy) capabilityState(workflow).select(options.policy);
	let selection = options.selection ?? {};
	let current = identity;
	const activity = createWorkspaceActivity(workflow, { getWorkspacePath: () => "/workspace", fileExists: options.fileExists ?? (async () => true) } as never, {
		stream: new WorkspaceEventStream({ journal: shared }), contextStore: { read: async () => selection, write: async () => {} },
		identity: async () => typeof current === "function" ? current() : current });
	activity.extension(pi as never);
	await fire("session_start");
	const prompt = async () => { const value = (await fire("before_agent_start", { systemPrompt: "base" }))?.systemPrompt as string | undefined; await shared.flush(); return value; };
	const reply = async (message: object = {}) => { await fire("message_end", { message: { role: "assistant", ...message } }); await shared.flush(); };
	return { fire, prompt, reply, workflow, activity,
		rebind: (next: typeof identity) => { current = next; }, select: (next: TeacherContext) => { selection = next; } };
}

describe("session-scoped events require a Chat session", () => {
	it("rejects a session event emitted without a valid session id and stores nothing", async () => {
		const project = await directory();
		const shared = await journal();
		const stream = new WorkspaceEventStream({ journal: shared });
		const inputs: Record<string, object> = { "chat.prompted": { learnMode: true }, "learn.enabled": {}, "learn.disabled": {}, "question.completed": {},
			"model.changed": { model: "school/tutor" }, "model.health": { available: false }, "budget.warning": { reason: "Low" },
			"budget.exhausted": { reason: "Limit" }, "learning.progress": { stage: "plan" } };
		expect(Object.keys(inputs).sort()).toEqual([...SESSION_SCOPED_EVENTS].sort());
		for (const [type, input] of Object.entries(inputs)) {
			for (const sessionId of [undefined, "", "../other", "a b"]) {
				expect(() => stream.emit({ projectPath: project, ...(sessionId === undefined ? {} : { sessionId }) }, "runtime", { type, ...input }))
					.toThrow("no session is bound");
			}
		}
		await shared.flush();
		expect(stream.events({ projectPath: project })).toEqual([]);
		expect(stream.session({ projectPath: project })).toEqual({});
		expect(stream.session({ projectPath: project, sessionId: "any" })).toEqual({});
		expect(await journalFiles(shared)).toEqual([]);
		// Project events still need no session.
		stream.emit({ projectPath: project }, "editor", { type: "file.changed", file: "src/app.ts" }, STUDENT_SURFACE_EVENTS);
		expect(stream.ui({ projectPath: project }).recentChanges).toHaveLength(1);
	});

	it("drops session events without a session identity on journal replay, for every reader", async () => {
		const project = await directory();
		const shared = await journal();
		const key = workspaceEventKey({ projectPath: project });
		const at = new Date().toISOString();
		await mkdir(shared.directory, { recursive: true });
		const lines: Array<{ type: WorkspaceEventType } & Record<string, unknown>> = [
			{ type: "learn.enabled" }, { type: "chat.prompted", learnMode: true }, { type: "model.health", available: false },
			{ type: "budget.exhausted", reason: "Limit" }, { type: "budget.warning", reason: "Low" }, { type: "model.changed", model: "school/tutor" },
			{ type: "learning.progress", stage: "review", understandingReady: true }, { type: "question.completed" },
			// An empty session is no session.
			{ type: "learn.enabled", session: "" }, { type: "model.health", available: false, session: null },
			{ type: "file.changed", file: "src/app.ts" },
		];
		for (const [index, value] of lines.entries()) {
			await appendFile(path.join(shared.directory, `${key}.jsonl`), `${JSON.stringify({ workspace: key, origin: "chat-process", seq: index + 1, at, source: "chat", ...value })}\n`);
		}
		for (const sessionId of [undefined, "session-one"]) {
			const reader = new WorkspaceEventStream({ journal: shared });
			const scope = { projectPath: project, ...(sessionId ? { sessionId } : {}) };
			await reader.refresh(scope);
			expect(reader.events(scope).map(event => event.type)).toEqual(["file.changed"]);
			expect(reader.session(scope)).toEqual({});
			expect(reader.ui(scope).learn).toBeUndefined();
		}
	});

	it("gives a session-less GUI reader project state only", async () => {
		const project = await directory();
		const shared = await journal();
		const one = await chat(project, shared, { sessionId: "session-one" }, { policy: limited });
		one.workflow.setLearnMode(true);
		one.workflow.updateLearningState({ currentStage: "understand", goalSummary: "Render the list", understandingReady: true, readyForNextStage: true });
		await one.prompt();
		capabilityState(one.workflow).turns = 1;
		await one.reply({ stopReason: "error" });
		const gui = new WorkspaceEventStream({ journal: shared });
		gui.emit({ projectPath: project }, "terminal", { type: "test.failed", command: "npm test", exitCode: 1 });
		const none = { projectPath: project };
		await gui.refresh(none);
		expect(gui.events(none).map(event => event.type).filter(type => SESSION_SCOPED_EVENTS.has(type))).toEqual([]);
		expect(gui.events(none).map(event => event.type)).toContain("test.failed");
		expect(gui.session(none)).toEqual({});
		expect(gui.ui(none).learn).toBeUndefined();
		expect(gui.ui(none).tests?.lastRun?.passed).toBe(false);
		// The emitting session still sees its own state.
		expect(gui.session({ ...none, sessionId: "session-one" })).toMatchObject({ learn: { enabled: true }, model: { available: false } });
	});

	describe("never leaks one Chat's state into a session-less workspace or another Chat", () => {
		const context = (project: string) => ({ identity: { kind: "personal" as const }, workspacePath: project, sandbox: { mode: "gondolin" as const } });
		const views = async (project: string, shared: WorkspaceEventJournal) => {
			const gui = new WorkspaceEventStream({ journal: shared });
			const view = async (sessionId?: string) => {
				const scope = { projectPath: project, ...(sessionId ? { sessionId } : {}) };
				await gui.refresh(scope);
				const session = gui.session(scope);
				const capabilities = resolveStudentCapabilities(context(project), { ...sessionCapabilitySignals(session), models: ["school/tutor"] });
				return { session, ui: gui.ui(scope), snapshot: buildStudentWorkspaceSnapshot({ workspace: { capabilities, ui: gui.ui(scope) }, session,
					map: { available: false, stale: false, staleFiles: [] } }) };
			};
			return { owner: await view("session-one"), other: await view("session-two"), none: await view() };
		};

		it("Learn", async () => {
			const project = await directory();
			const shared = await journal();
			const one = await chat(project, shared, { sessionId: "session-one" });
			one.workflow.setLearnMode(true);
			await one.prompt();
			const { owner, other, none } = await views(project, shared);
			expect(owner.snapshot.learn.enabled).toBe(true);
			for (const view of [other, none]) { expect(view.snapshot.learn.enabled).toBe(false); expect(view.ui.learn?.enabled ?? false).toBe(false); }
			expect(none.ui.learn).toBeUndefined();
		});

		it("budget", async () => {
			const project = await directory();
			const shared = await journal();
			const one = await chat(project, shared, { sessionId: "session-one" }, { policy: limited });
			await one.prompt();
			capabilityState(one.workflow).turns = 1;
			await one.reply();
			const { owner, other, none } = await views(project, shared);
			expect(owner.snapshot.budget.find(row => row.lane === "agent")?.status).toBe("exhausted");
			for (const view of [other, none]) {
				expect(view.session.budget).toBeUndefined();
				expect(view.snapshot.budget.find(row => row.lane === "agent")?.status).toBe("available");
				expect(view.snapshot.actions.find(item => item.action === "agent-edit")?.available).toBe(true);
			}
		});

		it("model health", async () => {
			const project = await directory();
			const shared = await journal();
			const one = await chat(project, shared, { sessionId: "session-one" });
			await one.prompt();
			await one.reply({ stopReason: "error" });
			const { owner, other, none } = await views(project, shared);
			expect(owner.snapshot.model).toEqual({ available: false, reason: "provider_unavailable" });
			for (const view of [other, none]) { expect(view.session.model).toBeUndefined(); expect(view.snapshot.model.available).toBe(true); }
		});

		it("learning progress", async () => {
			const project = await directory();
			const shared = await journal();
			const one = await chat(project, shared, { sessionId: "session-one" });
			one.workflow.updateLearningState({ currentStage: "understand", goalSummary: "Private goal", understandingReady: true, readyForNextStage: true });
			await one.prompt();
			const { owner, other, none } = await views(project, shared);
			expect(owner.snapshot.learning).toMatchObject({ stage: "plan", goal: "Private goal", source: "live" });
			expect(none.snapshot.learning).toMatchObject({ stage: "understand", source: "default" });
			expect(JSON.stringify(none.snapshot)).not.toContain("Private goal");
			expect(JSON.stringify(other.snapshot)).not.toContain("Private goal");
		});
	});
});

describe("managed workspace identity fails closed", () => {
	const classProject = (project: string): TeacherContext => ({ projectId: "class-project", classId: "class", organizationId: "school", workspacePath: project });

	it("keeps Alice and Bob apart in the same class project path", async () => {
		const project = await directory();
		const shared = await journal();
		const alice = await chat(project, shared, { userId: "alice", sessionId: "s1" }, { selection: classProject(project) });
		const bob = await chat(project, shared, { userId: "bob", sessionId: "s1" }, { selection: classProject(project) });
		expect(alice.activity.scope()).toMatchObject({ projectId: "class-project", userId: "alice" });
		expect(bob.activity.scope()).toMatchObject({ projectId: "class-project", userId: "bob" });
		await alice.fire("tool_call", { toolName: "edit", toolCallId: "e", input: { path: "/workspace/src/alice-only.ts" } });
		await alice.fire("tool_result", { toolName: "edit", toolCallId: "e", isError: false, content: [] });
		alice.workflow.setLearnMode(true);
		await alice.prompt();
		expect(await bob.prompt() ?? "").not.toContain("alice-only.ts");
		const gui = new WorkspaceEventStream({ journal: shared });
		const bobScope = { ...bob.activity.scope()!, sessionId: "s1" };
		await gui.refresh(bobScope);
		expect(gui.ui(bobScope).recentChanges).toEqual([]);
		expect(gui.session(bobScope).learn?.enabled ?? false).toBe(false);
	});

	it("never falls back to Alice's or an anonymous workspace when identity lookup fails after Alice used the project", async () => {
		const project = await directory();
		const shared = await journal();
		const alice = await chat(project, shared, { userId: "alice", sessionId: "alice-chat" }, { selection: classProject(project) });
		await alice.fire("tool_call", { toolName: "write", toolCallId: "w", input: { path: "/workspace/src/alice-secret.ts" } });
		await alice.fire("tool_result", { toolName: "write", toolCallId: "w", isError: false, content: [] });
		alice.workflow.setLearnMode(true);
		await alice.prompt();
		const before = await journalFiles(shared);

		// Another Chat in the same project path; the identity layer cannot resolve the student.
		const unknown = await chat(project, shared, () => { throw new Error("identity service unreachable"); }, { selection: classProject(project) });
		expect(unknown.activity.scope()).toBeUndefined();
		unknown.workflow.setLearnMode(true);
		const prompt = await unknown.prompt();
		expect(prompt ?? "").not.toMatch(/alice-secret|Workspace context/);
		await unknown.fire("tool_call", { toolName: "edit", toolCallId: "u", input: { path: "/workspace/src/unknown.ts" } });
		await unknown.fire("tool_result", { toolName: "edit", toolCallId: "u", isError: false, content: [] });
		await unknown.reply({ stopReason: "error" });
		unknown.activity.emit("editor", { type: "file.changed", file: "src/unknown.ts" });
		await shared.flush();
		// Nothing was written anywhere, in particular not to a user-less class key.
		expect(await journalFiles(shared)).toEqual(before);
		expect(before).not.toContain(`${workspaceEventKey({ projectPath: project, projectId: "class-project", organizationId: "school" })}.jsonl`);
		expect(await unknown.activity.actions()).toBeUndefined();

		// The same failure in Alice's own Chat unbinds it rather than keeping or reusing a student.
		alice.rebind(() => ({ sessionId: "alice-chat" }));
		await alice.prompt();
		expect(alice.activity.scope()).toBeUndefined();
	});

	it("keeps a personal workspace working without login", async () => {
		const project = await directory();
		const shared = await journal();
		const offline = await chat(project, shared, () => { throw new Error("offline"); });
		expect(offline.activity.scope()).toEqual({ projectPath: project });
		await offline.fire("tool_call", { toolName: "edit", toolCallId: "e", input: { path: "/workspace/src/app.ts" } });
		await offline.fire("tool_result", { toolName: "edit", toolCallId: "e", isError: false, content: [] });
		expect(offline.activity.stream.ui(offline.activity.scope()!).recentChanges).toMatchObject([{ file: "src/app.ts", author: "agent" }]);
		// A personal selection elsewhere does not make this project managed.
		const { resolveWorkspaceEventScope } = await import("../src/workspace-events.js");
		await expect(resolveWorkspaceEventScope(project, classProject(await directory()))).resolves.toEqual({ projectPath: project });
		await expect(resolveWorkspaceEventScope(project, classProject(project))).rejects.toBeInstanceOf(WorkspaceIdentityRequiredError);
	});
});

describe("delayed results after rebinding", () => {
	const rebinds = {
		project: { from: { userId: "alice", sessionId: "s1" }, to: { userId: "alice", sessionId: "s1" }, select: true },
		student: { from: { userId: "alice", sessionId: "s1" }, to: { userId: "bob", sessionId: "s1" }, select: false },
		session: { from: { userId: "alice", sessionId: "s1" }, to: { userId: "alice", sessionId: "s2" }, select: false },
	} as const;

	it.each(Object.keys(rebinds) as Array<keyof typeof rebinds>)("never turns an edit, write, command, test, model-health or budget result started before a %s switch into new activity", async kind => {
		const project = await directory();
		const shared = await journal();
		const rebind = rebinds[kind];
		const one = await chat(project, shared, rebind.from, { policy: limited });
		const before = one.activity.scope()!;
		// A turn and its tools start under the first binding.
		await one.prompt();
		await one.fire("tool_call", { toolName: "edit", toolCallId: "edit", input: { path: "/workspace/src/a.ts" } });
		await one.fire("tool_call", { toolName: "write", toolCallId: "write", input: { path: "/workspace/src/b.ts" } });
		await one.fire("tool_call", { toolName: "bash", toolCallId: "bash", input: { command: "ls -la" } });
		await one.fire("tool_call", { toolName: "bash", toolCallId: "test", input: { command: "npm test" } });
		capabilityState(one.workflow).turns = 1;

		one.rebind(rebind.to);
		if (rebind.select) one.select({ projectId: "class-project", organizationId: "school", workspacePath: project });
		await one.fire("session_start");
		const after = one.activity.scope()!;
		expect(workspaceEventKey(after) !== workspaceEventKey(before) || after.sessionId !== before.sessionId).toBe(true);

		// Results of the previous binding's tools and turn arrive now.
		await one.fire("tool_result", { toolName: "edit", toolCallId: "edit", isError: false, content: [] });
		await one.fire("tool_result", { toolName: "write", toolCallId: "write", isError: false, content: [] });
		await one.fire("tool_result", { toolName: "bash", toolCallId: "bash", isError: true, content: [{ type: "text", text: "Error: boom\nCommand exited with code 2" }] });
		await one.fire("tool_result", { toolName: "bash", toolCallId: "test", isError: true, content: [{ type: "text", text: "FAIL a.test.ts\nCommand exited with code 1" }] });
		await one.reply({ stopReason: "error" });

		const late: WorkspaceEventType[] = ["agent.files_changed", "terminal.command_finished", "test.passed", "test.failed", "model.health", "budget.exhausted", "budget.warning"];
		const gui = new WorkspaceEventStream({ journal: shared });
		await gui.refresh(after);
		for (const stream of [one.activity.stream, gui]) {
			expect(stream.events(after).map(event => event.type).filter(type => late.includes(type))).toEqual([]);
			expect(stream.ui(after)).toMatchObject({ recentChanges: [] });
			expect(stream.ui(after).tests).toBeUndefined();
			// Only a command's start is project state that other sessions of the same project share; its late outcome is not.
			if (kind === "session") expect(stream.ui(after).terminal).toEqual({ lastCommand: "npm test", actor: "agent" });
			else expect(stream.ui(after).terminal).toBeUndefined();
			expect(stream.session(after).budget).toBeUndefined();
			expect(stream.session(after).model?.available).toBeUndefined();
		}

		// A turn started under the new binding reports normally.
		await one.prompt();
		await one.fire("tool_call", { toolName: "edit", toolCallId: "fresh", input: { path: "/workspace/src/c.ts" } });
		await one.fire("tool_result", { toolName: "edit", toolCallId: "fresh", isError: false, content: [] });
		await one.reply({ stopReason: "error" });
		expect(one.activity.stream.ui(after).recentChanges.map(change => change.file)).toEqual(["src/c.ts"]);
		expect(one.activity.stream.session(after)).toMatchObject({ model: { available: false }, budget: { exhausted: { lane: "agent" } } });
	});

	it("drops an edit whose file check was still running when the Chat was rebound", async () => {
		const project = await directory();
		const shared = await journal();
		let release!: () => void;
		const checking = new Promise<void>(resolve => { release = resolve; });
		const one = await chat(project, shared, { userId: "alice", sessionId: "s1" }, { fileExists: async () => { await checking; return true; } });
		const call = one.fire("tool_call", { toolName: "edit", toolCallId: "slow", input: { path: "/workspace/src/a.ts" } });
		one.rebind({ userId: "bob", sessionId: "s1" });
		await one.fire("session_start");
		release();
		await call;
		await one.fire("tool_result", { toolName: "edit", toolCallId: "slow", isError: false, content: [] });
		expect(one.activity.stream.ui(one.activity.scope()!).recentChanges).toEqual([]);
	});
});
