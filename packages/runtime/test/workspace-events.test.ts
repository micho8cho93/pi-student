import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkspaceEvent } from "@pi-student/contracts";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { TeacherContext } from "@pi-student/telemetry/types";
import { describeWorkspaceActivity, resolveWorkspaceEventScope, STUDENT_SURFACE_EVENTS, summarizeTestFailure, WorkspaceEventJournal,
	WorkspaceEventStream } from "../src/workspace-events.js";
import { createWorkspaceActivity } from "../src/workspace-activity.js";

const roots: string[] = [];
const journals: WorkspaceEventJournal[] = [];
afterEach(async () => {
	await Promise.all(journals.splice(0).map(journal => journal.flush()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory(prefix = "pi-events-") {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return realpath(root);
}

describe("workspace event stream", () => {
	it("delivers events in emission order, including events emitted by listeners", async () => {
		const scope = { projectPath: await directory() };
		const stream = new WorkspaceEventStream();
		const seen: string[] = [];
		stream.subscribe(scope, event => {
			seen.push(event.type);
			if (event.type === "file.opened") stream.emit(scope, "editor", { type: "editor.selection_changed", file: "src/a.ts", startLine: 1, endLine: 2 });
		});
		stream.subscribe(scope, event => { seen.push(`second:${event.type}`); });
		stream.emit(scope, "editor", { type: "file.opened", file: "src/a.ts" });
		stream.emit(scope, "chat", { type: "chat.prompted", learnMode: false });
		expect(seen).toEqual(["file.opened", "second:file.opened", "editor.selection_changed", "second:editor.selection_changed", "chat.prompted", "second:chat.prompted"]);
		const seqs = stream.events(scope).map(event => event.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(stream.events(scope).map(event => event.type)).toEqual(["file.opened", "editor.selection_changed", "chat.prompted"]);
	});

	it("keeps workspaces isolated", async () => {
		const a = { projectPath: await directory() };
		const b = { projectPath: await directory() };
		const classProject = { projectPath: a.projectPath, projectId: "project-a", organizationId: "org-a" };
		const journal = new WorkspaceEventJournal(await directory("pi-journal-"));
		const bridge = new WorkspaceEventStream({ journal });
		const runtime = new WorkspaceEventStream({ journal });
		const received: WorkspaceEvent[] = [];
		runtime.subscribe(b, event => received.push(event));
		bridge.emit(a, "editor", { type: "file.changed", file: "src/plan.ts" });
		bridge.emit(classProject, "editor", { type: "file.opened", file: "src/index.ts" });
		await journal.flush();
		await runtime.refresh(b);
		expect(received).toEqual([]);
		expect(runtime.ui(b)).toEqual({ openFiles: [], recentChanges: [] });
		await runtime.refresh(a);
		expect(runtime.ui(a).recentChanges.map(change => change.file)).toEqual(["src/plan.ts"]);
		expect(runtime.ui(a).openFiles).toEqual([]);
		expect(bridge.ui(classProject).recentChanges).toEqual([]);
		expect(() => bridge.emit(a, "editor", { type: "file.changed", file: path.join(b.projectPath, "x.ts") })).toThrow("outside the project");
		expect(() => bridge.emit(a, "editor", { type: "agent.files_changed", files: [{ file: "x.ts", kind: "modified" }] }, STUDENT_SURFACE_EVENTS)).toThrow("not supported");
	});

	it("binds a class selection only to the workspace it was selected for", async () => {
		const project = await directory();
		const other = await directory();
		const selection: TeacherContext = { projectId: "project-a", organizationId: "org-a", workspacePath: project };
		expect(await resolveWorkspaceEventScope(project, selection)).toEqual({ projectPath: project, projectId: "project-a", organizationId: "org-a" });
		expect(await resolveWorkspaceEventScope(other, selection)).toEqual({ projectPath: other });
	});

	it("distinguishes student-authored and agent-authored edits", async () => {
		const scope = { projectPath: await directory() };
		const stream = new WorkspaceEventStream();
		stream.emit(scope, "editor", { type: "file.changed", file: "src/app.ts" });
		stream.emit(scope, "chat", { type: "agent.files_changed", files: [{ file: "src/app.ts", kind: "modified" }, { file: "src/new.ts", kind: "created" }] });
		stream.emit(scope, "editor", { type: "file.changed", file: "src/app.ts" });
		expect(stream.ui(scope).recentChanges.map(({ file, author, kind }) => ({ file, author, kind }))).toEqual([
			{ file: "src/app.ts", author: "agent", kind: "modified" },
			{ file: "src/new.ts", author: "agent", kind: "created" },
			{ file: "src/app.ts", author: "student", kind: "modified" },
		]);
		const summary = describeWorkspaceActivity(stream.ui(scope))!;
		expect(summary).toContain("The student edited these files themselves in the editor: src/app.ts.");
		expect(summary).toContain("Files you (the assistant) changed: src/app.ts, src/new.ts.");
	});

	it("marks the flowchart stale after relevant source changes, across processes", async () => {
		const scope = { projectPath: await directory() };
		const journal = new WorkspaceEventJournal(await directory("pi-journal-"));
		const bridge = new WorkspaceEventStream({ journal });
		const runtime = new WorkspaceEventStream({ journal });
		const stale: WorkspaceEvent[] = [];
		bridge.subscribe(scope, event => { if (event.type === "flowchart.stale") stale.push(event); });
		bridge.emit(scope, "editor", { type: "file.changed", file: "src/before.ts" });
		expect(bridge.ui(scope).flowchart).toBeUndefined();
		bridge.emit(scope, "flowchart", { type: "flowchart.generated", filesRead: 4, model: "openai/small" });
		for (const file of ["notes.txt", "node_modules/x/index.js", ".env", "dist/app.js", "src/app.test.ts.snap"]) bridge.emit(scope, "editor", { type: "file.changed", file });
		expect(bridge.ui(scope).flowchart).toMatchObject({ stale: false });
		bridge.emit(scope, "editor", { type: "file.changed", file: "src/app.ts" });
		bridge.emit(scope, "editor", { type: "file.changed", file: "src/other.ts" });
		expect(bridge.ui(scope).flowchart).toMatchObject({ stale: true, staleFiles: ["src/app.ts", "src/other.ts"] });
		expect(stale.map(event => event.type === "flowchart.stale" && event.files)).toEqual([["src/app.ts"]]);
		expect(bridge.events(scope).at(-2)?.type).toBe("flowchart.stale");

		bridge.emit(scope, "flowchart", { type: "flowchart.generated", filesRead: 4 });
		await journal.flush();
		await runtime.refresh(scope);
		expect(runtime.ui(scope).flowchart).toMatchObject({ stale: false });
		runtime.emit(scope, "chat", { type: "agent.files_changed", files: [{ file: "src/agent.py", kind: "created" }] });
		await journal.flush();
		await bridge.refresh(scope);
		expect(bridge.ui(scope).flowchart).toMatchObject({ stale: true, staleFiles: ["src/agent.py"] });
		expect(describeWorkspaceActivity(bridge.ui(scope))).toContain("flowchart is out of date (changed since it was generated: src/agent.py)");
	});

	it("keeps only metadata and omits sensitive files from model context", async () => {
		const scope = { projectPath: await directory() };
		const journal = new WorkspaceEventJournal(await directory("pi-journal-"));
		const stream = new WorkspaceEventStream({ journal });
		const event = stream.emit(scope, "editor", { type: "file.changed", file: ".env", content: "API_KEY=sk-live-abcdefghijklmnop" } as never);
		expect(event).toMatchObject({ type: "file.changed", file: ".env", sensitive: true });
		expect(event).not.toHaveProperty("content");
		stream.emit(scope, "editor", { type: "editor.selection_changed", file: "config/secrets.json", startLine: 1, endLine: 4 });
		stream.emit(scope, "chat", { type: "agent.files_changed", files: [{ file: "credentials.json", kind: "modified" }, { file: "src/app.ts", kind: "modified" }] });
		stream.emit(scope, "terminal", { type: "test.failed", command: "npm test -- --token=ghp_abcdefghijklmnopqrstuvwxyz", exitCode: 1,
			summary: "FAIL src/app.test.ts\nError: cannot read .env\nconsole.log noise\nAssertionError: expected 2 to be 3\npassword=hunter2 failed" });
		await journal.flush();
		const ui = stream.ui(scope);
		expect(ui.recentChanges.map(change => change.file)).toEqual(["src/app.ts"]);
		expect(ui.selectedCode).toBeUndefined();
		const summary = describeWorkspaceActivity(ui)!;
		for (const hidden of [".env", "secrets.json", "credentials.json", "hunter2", "ghp_", "sk-live", "console.log"]) expect(summary).not.toContain(hidden);
		expect(summary).toContain("AssertionError: expected 2 to be 3");
		const stored = await readFile(path.join(journal.directory, `${event.workspace}.jsonl`), "utf8");
		for (const hidden of ["sk-live", "hunter2", "ghp_"]) expect(stored).not.toContain(hidden);
		expect(summarizeTestFailure("all good\nnothing to see")).toBeUndefined();
	});
});

describe("workspace activity in the chat session", () => {
	type Handler = (event: any, ctx?: any) => Promise<any>;
	async function session(workspace: string) {
		const handlers = new Map<string, Handler[]>();
		const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
		const fire = async (name: string, event: object = {}) => {
			let result;
			for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }) ?? result;
			return result;
		};
		let selection: TeacherContext = {};
		const workflow = new WorkflowController(createLearningSession(workspace));
		const sandbox = { getWorkspacePath: () => "/workspace", fileExists: async (file: string) => file.endsWith("existing.ts") } as never;
		const journal = new WorkspaceEventJournal(await directory("pi-journal-"));
		journals.push(journal);
		const activity = createWorkspaceActivity(workflow, sandbox, {
			stream: new WorkspaceEventStream({ journal }),
			contextStore: { read: async () => selection, write: async value => { selection = value; } },
		});
		activity.extension(pi as never);
		await fire("session_start");
		return { fire, workflow, activity, journal, select: (value: TeacherContext) => { selection = value; } };
	}

	it("records agent edits and failed tests as context without pasting output", async () => {
		const { fire, activity } = await session(await directory());
		await fire("tool_call", { toolName: "edit", toolCallId: "1", input: { path: "/workspace/src/existing.ts" } });
		await fire("tool_result", { toolName: "edit", toolCallId: "1", isError: false, content: [] });
		await fire("tool_call", { toolName: "write", toolCallId: "2", input: { path: "/etc/passwd" } });
		await fire("tool_result", { toolName: "write", toolCallId: "2", isError: false, content: [] });
		await fire("tool_call", { toolName: "bash", toolCallId: "3", input: { command: "npm test" } });
		const output = `${"ok line\n".repeat(500)} FAIL test/math.test.ts > adds\nAssertionError: expected 3 to be 4\nCommand exited with code 1`;
		await fire("tool_result", { toolName: "bash", toolCallId: "3", isError: true, content: [{ type: "text", text: output }] });
		const scope = activity.scope()!;
		expect(activity.stream.events(scope).map(event => event.type)).toEqual(["agent.files_changed", "terminal.command_started", "test.started", "terminal.command_finished", "test.failed"]);
		expect(activity.stream.ui(scope).tests?.lastRun).toMatchObject({ command: "npm test", passed: false, exitCode: 1, summary: "FAIL test/math.test.ts > adds\nAssertionError: expected 3 to be 4" });
		expect(activity.stream.ui(scope).recentChanges).toMatchObject([{ file: "src/existing.ts", author: "agent", kind: "modified" }]);
		const prompt = await fire("before_agent_start", { systemPrompt: "base", prompt: "why did it fail?" });
		expect(prompt.systemPrompt).toContain("Latest test run `npm test` failed (exit 1)");
		expect(prompt.systemPrompt).not.toContain("ok line");
		expect(activity.stream.events(scope).at(-1)).toMatchObject({ type: "chat.prompted", learnMode: false });
	});

	it("reports capability, learn and budget changes", async () => {
		const { fire, workflow, activity } = await session(await directory());
		const state = capabilityState(workflow);
		state.select({ projectId: "p", version: 2, sourceVersions: {}, settings: { ...DEFAULT_CAPABILITY_POLICY, terminal: false, limits: { ...DEFAULT_CAPABILITY_POLICY.limits, turns: 1 } } });
		workflow.setLearnMode(true);
		await fire("before_agent_start", { systemPrompt: "base" });
		state.turns = 1;
		await fire("message_end", { message: { role: "assistant" } });
		await fire("message_end", { message: { role: "assistant" } });
		const events = activity.stream.events(activity.scope()!);
		expect(events.map(event => event.type)).toEqual(["learn.enabled", "capability.changed", "chat.prompted", "budget.exhausted"]);
		expect(events[1]).toMatchObject({ changed: ["terminal", "limits"] });
		expect(events[2]).toMatchObject({ learnMode: true });
	});

	it("clears transient state from the previous project when the project changes", async () => {
		const workspace = await directory();
		const { fire, activity, select, journal } = await session(workspace);
		await fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "npm test" } });
		await fire("tool_result", { toolName: "bash", toolCallId: "1", isError: true, content: [{ type: "text", text: "Error: boom\nCommand exited with code 1" }] });
		const personal = activity.scope()!;
		expect(activity.stream.ui(personal).tests?.lastRun?.passed).toBe(false);
		await journal.flush();

		select({ projectId: "class-project", organizationId: "org", workspacePath: workspace });
		const prompt = await fire("before_agent_start", { systemPrompt: "base" });
		const classScope = activity.scope()!;
		expect(classScope).toMatchObject({ projectId: "class-project" });
		expect(activity.stream.events(personal)).toEqual([]);
		expect(activity.stream.ui(classScope).tests).toBeUndefined();
		expect(activity.stream.events(classScope).map(event => event.type)).toEqual(["capability.changed", "chat.prompted"]);
		expect(activity.stream.events(classScope)[0]).toMatchObject({ changed: ["project"] });
		expect(prompt).toBeUndefined();
	});
});
