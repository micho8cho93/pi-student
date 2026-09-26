import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionContext, NextAvailableAction } from "@pi-student/contracts";
import { resolveLearnScaffolding } from "@pi-student/education/learn-scaffolding";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";
import { LEARNING_STAGES } from "@pi-student/education/stage";
import { CURRENT_WORK_TOPIC } from "@pi-student/education/extension";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { TeacherContext } from "@pi-student/telemetry/types";
import { resolveExecutionContext } from "../src/execution-context.js";
import { createStudentWorkspace, resolveStudentCapabilities } from "../src/student-workspace.js";
import { WorkspaceEventJournal, WorkspaceEventStream } from "../src/workspace-events.js";
import { buildWorkspaceChatContext } from "../src/workspace-chat-context.js";
import { buildQuestionWorkspaceContext } from "../src/question-workspace-context.js";
import { createWorkspaceActivity } from "../src/workspace-activity.js";

const roots: string[] = [];
const journals: WorkspaceEventJournal[] = [];
afterEach(async () => {
	await Promise.all(journals.splice(0).map(journal => journal.flush()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory(prefix = "pi-learn-ws-") {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return realpath(root);
}

type Handler = (event: any, ctx?: any) => Promise<any>;
/** A chat session wired to a shared stream, as the runtime does for each Pi session. */
async function chat(workspace: string, stream: WorkspaceEventStream) {
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
	const fire = async (name: string, event: object = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }) ?? result;
		return result;
	};
	let selection: TeacherContext = {};
	const workflow = new WorkflowController(createLearningSession(workspace));
	const sandbox = { getWorkspacePath: () => "/workspace", fileExists: async () => true } as never;
	const activity = createWorkspaceActivity(workflow, sandbox, { stream, contextStore: { read: async () => selection, write: async value => { selection = value; } } });
	activity.extension(pi as never);
	await fire("session_start");
	return { fire, workflow, activity, select: (value: TeacherContext) => { selection = value; } };
}

async function sharedStream() {
	const journal = new WorkspaceEventJournal(await directory("pi-learn-journal-"));
	journals.push(journal);
	return new WorkspaceEventStream({ journal });
}

describe("Learn Mode across Chat, Code, Map and Terminal", () => {
	it("stays consistent while the student switches surfaces", async () => {
		const workspace = await directory();
		const stream = await sharedStream();
		const { fire, workflow, activity } = await chat(workspace, stream);
		const scope = activity.scope()!;
		workflow.setLearnMode(true);
		const learn = () => resolveLearnScaffolding(stream.ui(scope).learn?.enabled === true);
		expect(learn()).toEqual(resolveLearnScaffolding(true));

		// Code, Map and Terminal report activity; none of it changes Learn.
		const surfaces = [
			() => stream.emit(scope, "editor", { type: "file.opened", file: "src/socket.ts" }),
			() => stream.emit(scope, "editor", { type: "file.changed", file: "src/socket.ts" }),
			() => stream.emit(scope, "editor", { type: "editor.selection_changed", file: "src/socket.ts", startLine: 10, endLine: 18 }),
			() => stream.emit(scope, "flowchart", { type: "flowchart.node_selected", id: "reconnect", label: "Reconnect loop", file: "src/socket.ts", symbol: "scheduleReconnect" }),
			() => stream.emit(scope, "terminal", { type: "terminal.command_finished", command: "npm test", exitCode: 1, summary: "FAIL test/socket.test.ts > reconnects\nAssertionError: expected 1 to be 2" }),
			() => stream.emit(scope, "terminal", { type: "test.failed", command: "npm test", exitCode: 1, summary: "FAIL test/socket.test.ts > reconnects\nAssertionError: expected 1 to be 2" }),
		];
		for (const surface of surfaces) { surface(); expect(learn()).toEqual(resolveLearnScaffolding(true)); }

		// Chat sees the same setting and scaffolds around what the other surfaces reported.
		const prompt = (await fire("before_agent_start", { systemPrompt: "base" })).systemPrompt as string;
		expect(prompt).toContain('Learning focus (selected node): "Reconnect loop"');
		expect(prompt).toContain("build on the student's own changes");
		expect(prompt).toContain("explain what this failure means and ask what the student thinks caused it before proposing a fix");
		expect(prompt).toContain("explain it step by step");
		expect(stream.events(scope).at(-1)).toMatchObject({ type: "chat.prompted", learnMode: true });
		expect(learn().enabled).toBe(true);

		// Turning Learn off from any surface is seen everywhere, including the next chat turn.
		stream.emit(scope, "learn", { type: "learn.disabled" });
		expect(learn()).toEqual(resolveLearnScaffolding(false));
		workflow.setLearnMode(false);
		stream.emit(scope, "terminal", { type: "test.failed", command: "npm test", exitCode: 1 });
		const plain = (await fire("before_agent_start", { systemPrompt: "base" })).systemPrompt as string;
		expect(plain).not.toContain("Learn Mode");
		expect(plain).toContain('Selected node: "Reconnect loop"');
	});

	it("does not leak Learn state across projects", async () => {
		const stream = await sharedStream();
		const a = await chat(await directory("pi-learn-a-"), stream);
		const b = await chat(await directory("pi-learn-b-"), stream);
		a.workflow.setLearnMode(true);
		await a.fire("before_agent_start", { systemPrompt: "base" });
		expect(stream.ui(a.activity.scope()!).learn?.enabled).toBe(true);
		expect(stream.ui(b.activity.scope()!).learn).toBeUndefined();
		expect(stream.events(b.activity.scope()!).some(event => event.type.startsWith("learn.") || (event.type === "chat.prompted" && event.learnMode))).toBe(false);
		stream.emit(b.activity.scope()!, "editor", { type: "file.changed", file: "src/b.ts" });
		const prompt = (await b.fire("before_agent_start", { systemPrompt: "base" })).systemPrompt as string;
		expect(prompt).not.toContain("Learn Mode");

		// Moving a chat to another project scope drops the previous scope's state. The Map's Learn toggle
		// there does not follow; the new scope only learns this chat's own setting.
		a.workflow.setLearnMode(false);
		const previous = a.activity.scope()!;
		stream.emit(previous, "learn", { type: "learn.enabled" });
		stream.emit(previous, "flowchart", { type: "flowchart.node_selected", id: "n", label: "Old project step" });
		await a.fire("tool_call", { toolName: "edit", toolCallId: "old-project-edit", input: { path: "/workspace/src/old-project.ts" } });
		await a.fire("tool_call", { toolName: "bash", toolCallId: "old-project-test", input: { command: "npm test" } });
		a.select({ projectId: "class-project", organizationId: "org", workspacePath: previous.projectPath });
		const moved = (await a.fire("before_agent_start", { systemPrompt: "base" }))?.systemPrompt ?? "";
		// Delayed completions from the previous scope must not become this project's activity.
		await a.fire("tool_result", { toolName: "edit", toolCallId: "old-project-edit", isError: false, content: [] });
		await a.fire("tool_result", { toolName: "bash", toolCallId: "old-project-test", isError: true, content: [{ type: "text", text: "FAIL old-project.test.ts\nCommand exited with code 1" }] });
		expect(stream.events(previous)).toEqual([]);
		expect(stream.ui(a.activity.scope()!).learn?.enabled ?? false).toBe(false);
		expect(stream.ui(a.activity.scope()!).flowchart).toBeUndefined();
		expect(stream.ui(a.activity.scope()!).recentChanges).toEqual([]);
		expect(stream.ui(a.activity.scope()!).tests).toBeUndefined();
		expect(moved).not.toContain("Old project step");
		expect(moved).not.toContain("Learn Mode");
	});
});

describe("/question grounded in current work", () => {
	it("uses the current project's activity, plan and decisions", async () => {
		const stream = await sharedStream();
		const { fire, workflow, activity } = await chat(await directory(), stream);
		const scope = activity.scope()!;
		workflow.state.stage = "implement";
		workflow.state.goal = "Keep the chat connected when the network drops";
		workflow.state.plan.steps.push({ id: "step-1", description: "Retry the connection on an interval", status: "active", studentAuthored: true },
			{ id: "step-2", description: "Agent-suggested refactor", status: "pending", studentAuthored: false });
		workflow.state.plan.studentAcknowledgements.push("Use a fixed 2s interval instead of exponential backoff");
		stream.emit(scope, "editor", { type: "file.changed", file: "src/socket/reconnect.ts" });
		stream.emit(scope, "editor", { type: "file.changed", file: ".env" });
		stream.emit(scope, "flowchart", { type: "flowchart.node_selected", id: "reconnect", label: "Reconnect handler", file: "src/socket/reconnect.ts", symbol: "scheduleReconnect" });
		stream.emit(scope, "terminal", { type: "test.failed", command: "npm test", exitCode: 1,
			summary: "FAIL test/reconnect.test.ts > clears the interval\nError: token=ghp_abcdefghijklmnopqrstuvwxyz0123 rejected" });

		workflow.setQuestion({ difficulty: "medium", topic: CURRENT_WORK_TOPIC, phase: "generate" });
		const prompt = (await fire("before_agent_start", { systemPrompt: "base" })).systemPrompt as string;
		expect(prompt).toContain("Current work in this project");
		expect(prompt).toContain("Learning stage: IMPLEMENT");
		expect(prompt).toContain("Goal: Keep the chat connected when the network drops");
		expect(prompt).toContain("in progress: 1. Retry the connection on an interval");
		expect(prompt).not.toContain("Agent-suggested refactor");
		expect(prompt).toContain("Use a fixed 2s interval instead of exponential backoff");
		expect(prompt).toContain("- src/socket/reconnect.ts");
		expect(prompt).toContain('Selected Flowchart component: "Reconnect handler" — src/socket/reconnect.ts (scheduleReconnect)');
		expect(prompt).toContain("test/reconnect.test.ts > clears the interval failed");
		// Metadata only: credential-like paths and secret values never reach the question prompt.
		expect(prompt).not.toContain(".env");
		expect(prompt).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
		// The general chat summary is replaced, not duplicated.
		expect(prompt).not.toContain("Workspace context (metadata only");

		// The answer turn does not get a new question context.
		workflow.setQuestion({ difficulty: "medium", topic: CURRENT_WORK_TOPIC, phase: "answer" });
		expect(((await fire("before_agent_start", { systemPrompt: "base" }))?.systemPrompt ?? "")).not.toContain("Current work in this project");
	});

	it("excludes activity from unrelated projects and stale activity", async () => {
		const stream = await sharedStream();
		const other = await chat(await directory("pi-question-other-"), stream);
		stream.emit(other.activity.scope()!, "editor", { type: "file.changed", file: "src/unrelated-game.ts" });
		stream.emit(other.activity.scope()!, "terminal", { type: "test.failed", command: "pytest", exitCode: 1, failedTests: ["tests/test_game.py::test_score"] });

		const current = await chat(await directory("pi-question-current-"), stream);
		stream.emit(current.activity.scope()!, "editor", { type: "file.changed", file: "src/todo.ts" });
		current.workflow.setQuestion({ difficulty: "easy", topic: CURRENT_WORK_TOPIC, phase: "generate" });
		const prompt = (await current.fire("before_agent_start", { systemPrompt: "base" })).systemPrompt as string;
		expect(prompt).toContain("src/todo.ts");
		expect(prompt).not.toContain("unrelated-game");
		expect(prompt).not.toContain("test_score");

		// Hours-old edits are not "current work"; with nothing current the question falls back to the whole project.
		const at = "2026-01-01T08:00:00.000Z";
		const ui = { openFiles: [], recentChanges: [{ file: "src/old.ts", kind: "modified" as const, author: "student" as const, at }],
			tests: { lastRun: { command: "npm test", passed: false, actor: "student" as const, at } } };
		expect(buildQuestionWorkspaceContext({ ui, stage: "understand", now: new Date("2026-01-01T09:00:00.000Z") })).toContain("src/old.ts");
		expect(buildQuestionWorkspaceContext({ ui, stage: "understand", now: new Date("2026-01-01T20:00:00.000Z") })).toBeUndefined();
	});
});

describe("Learn changes scaffolding, not security or capability policy", () => {
	async function managedContext(): Promise<ExecutionContext> {
		const workspacePath = await directory();
		const policy = { projectId: "project-a", version: 1, sourceVersions: { organization: 1 },
			settings: { ...DEFAULT_CAPABILITY_POLICY, models: ["openai/small"], terminal: false } };
		return resolveExecutionContext({ workspacePath, sessionId: "session-a",
			selection: { workspacePath, projectId: "project-a", classId: "class-a", organizationId: "org-a" },
			identityProvider: { getIdentity: async () => ({ kind: "student" as const, userId: "student-a" }) },
			scopeProvider: { resolve: vi.fn(async () => ({ projectId: "project-a", classId: "class-a", organizationId: "org-a", userId: "student-a" })) },
			policyProvider: { resolvePolicy: vi.fn(async () => policy) },
			environmentProvider: { resolve: vi.fn(async () => ({ sandbox: { mode: "gondolin" as const }, skills: [], mcps: [] })) } });
	}

	it("leaves capabilities, scope and tool permissions unchanged", async () => {
		const context = await managedContext();
		const capabilities = resolveStudentCapabilities(context);
		const on = createStudentWorkspace(context, { capabilities, learning: { stage: "implement", learnMode: true } });
		const off = createStudentWorkspace(context, { capabilities, learning: { stage: "implement", learnMode: false } });
		expect(on.capabilities).toEqual(off.capabilities);
		expect(on.scope).toEqual(off.scope);
		expect(on.capabilities.terminal.allowed).toBe(false);

		const workflow = new WorkflowController(createLearningSession(context.workspacePath));
		for (const stage of LEARNING_STAGES) {
			workflow.state.stage = stage;
			const permissions = (learn: boolean) => {
				workflow.setLearnMode(learn);
				return workflow.getRegisteredTools().filter(tool => tool !== "codebase_model").map(tool => [tool, workflow.canUseTool(tool)]);
			};
			expect(permissions(true)).toEqual(permissions(false));
			// Learn is not a read-only mode; only /question practice narrows tools.
			workflow.setLearnMode(true);
			expect(workflow.isPracticingQuestion()).toBe(false);
		}
	});

	it("keeps assistance limits identical and autocomplete short in every mode", () => {
		const actions: NextAvailableAction[] = [
			{ action: "agent-edit", available: false, reason: "File editing is disabled for this project." },
			{ action: "agent-run-command", available: false, reason: "Terminal commands are disabled for this project." },
		] as never;
		const ui = { openFiles: [], recentChanges: [] };
		const limits = (text?: string) => text?.slice(text.indexOf("Assistance limits"));
		expect(limits(buildWorkspaceChatContext({ ui, actions, learn: resolveLearnScaffolding(true) })))
			.toBe(limits(buildWorkspaceChatContext({ ui, actions, learn: resolveLearnScaffolding(false) })));

		for (const learn of [true, false]) {
			const scaffolding = resolveLearnScaffolding(learn);
			expect(scaffolding.editor.autocomplete).toBe("concise");
			expect(scaffolding.terminal.blocksCommands).toBe(false);
			// The profile has no permission-shaped fields at all.
			expect(JSON.stringify(scaffolding)).not.toMatch(/"(?:allowed|code|models|tools|reasoningLevels|budget|internet|sandbox)"/);
		}
	});
});
