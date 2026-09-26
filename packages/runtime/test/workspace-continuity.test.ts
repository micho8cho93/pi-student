import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EffectiveStudentCapabilities } from "@pi-student/contracts";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { resolveExecutionContext } from "../src/execution-context.js";
import { resolveStudentCapabilities } from "../src/student-workspace.js";
import { createWorkspaceActivity, type WorkspaceCapabilityResolver } from "../src/workspace-activity.js";
import { buildWorkspaceChatContext } from "../src/workspace-chat-context.js";
import { STUDENT_SURFACE_EVENTS, WorkspaceEventJournal, WorkspaceEventStream } from "../src/workspace-events.js";

const roots: string[] = [];
const journals: WorkspaceEventJournal[] = [];
afterEach(async () => {
	await Promise.all(journals.splice(0).map(journal => journal.flush()));
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory(prefix = "pi-continuity-") {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return realpath(root);
}

type Handler = (event: any, ctx?: any) => Promise<any>;

/** A chat session and a separate GUI bridge process sharing one workspace journal. */
async function workspace(options: { capabilities?: WorkspaceCapabilityResolver } = {}) {
	const project = await directory();
	const journal = new WorkspaceEventJournal(await directory("pi-journal-"));
	journals.push(journal);
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
	const notify = vi.fn();
	const fire = async (name: string, event: object = {}) => {
		let result;
		for (const handler of handlers.get(name) ?? []) result = await handler({ type: name, ...event }, { ui: { notify } }) ?? result;
		return result;
	};
	const workflow = new WorkflowController(createLearningSession(project));
	const sandbox = { getWorkspacePath: () => "/workspace", fileExists: async () => true } as never;
	const activity = createWorkspaceActivity(workflow, sandbox, {
		stream: new WorkspaceEventStream({ journal }),
		contextStore: { read: async () => ({}), write: async () => {} },
		capabilities: options.capabilities,
		// A signed-out (personal) student in one Pi session.
		identity: async () => ({ sessionId: "chat-session" }),
	});
	activity.extension(pi as never);
	await fire("session_start");
	const gui = new WorkspaceEventStream({ journal });
	const scope = { projectPath: project };
	/** What the Paseo bridge does for a request from the student's GUI. */
	const report = async (source: "editor" | "terminal" | "flowchart", event: Record<string, unknown>) => {
		gui.emit(scope, source, event, STUDENT_SURFACE_EVENTS);
		await journal.flush();
	};
	const prompt = async () => (await fire("before_agent_start", { systemPrompt: "base" }))?.systemPrompt as string | undefined;
	return { project, fire, notify, activity, gui, scope, report, prompt, journal };
}

describe("Chat ↔ Editor", () => {
	it("tells Chat what the student changed since the previous AI turn, by author", async () => {
		const { fire, report, prompt, gui, scope, journal } = await workspace();
		await prompt();
		await fire("tool_call", { toolName: "edit", toolCallId: "1", input: { path: "/workspace/src/server.ts" } });
		await fire("tool_result", { toolName: "edit", toolCallId: "1", isError: false, content: [] });

		await report("editor", { type: "file.opened", file: "src/client.ts" });
		await report("editor", { type: "file.changed", file: "src/socket.ts" });
		await report("editor", { type: "file.changed", file: "src/client.ts" });
		await report("editor", { type: "autocomplete.accepted", file: "src/client.ts" });
		gui.emit(scope, "terminal", { type: "test.failed", command: "npm test", exitCode: 1,
			summary: "✓ src/other.test.ts\nFAIL src/reconnect.test.ts > reconnects after close\nAssertionError: expected 'closed' to be 'open'" });
		await journal.flush();
		await report("editor", { type: "file.opened", file: "src/socket.ts" });
		await report("editor", { type: "editor.selection_changed", file: "src/socket.ts", startLine: 10, endLine: 14 });

		const context = (await prompt())!;
		expect(context).toContain([
			"Since the previous AI turn:",
			"Student modified (typed themselves):", "- src/socket.ts", "- src/client.ts",
			"Student accepted AI autocomplete suggestions in:", "- src/client.ts",
			"You (the assistant) modified:", "- src/server.ts",
			"Tests:", "- src/reconnect.test.ts > reconnects after close failed (`npm test`, run by the student, exit 1)",
		].join("\n"));
		expect(context).toContain("Current file:\n- src/socket.ts (lines 10-14 selected)");
		expect(context).toContain("AssertionError: expected 'closed' to be 'open'");
		expect(context).not.toContain("src/other.test.ts");

		// Nothing new happened: no "since" section, only the current state.
		const next = (await prompt())!;
		expect(next).not.toContain("Since the previous AI turn");
		expect(next).not.toContain("Tests:");
		expect(next).toContain("Current file:\n- src/socket.ts");
	});

	it("never names credential-like files or forwards contents", async () => {
		const { report, prompt } = await workspace();
		await prompt();
		await report("editor", { type: "file.changed", file: ".env", content: "API_KEY=sk-live-abcdefghijklmnop" });
		await report("editor", { type: "file.opened", file: "config/secrets.json" });
		await report("editor", { type: "autocomplete.accepted", file: "src/app.ts", text: "const key = 'sk-live-abcdefghijklmnop'" });
		const context = (await prompt())!;
		expect(context).toContain("- src/app.ts");
		for (const hidden of [".env", "secrets.json", "sk-live"]) expect(context).not.toContain(hidden);
	});
});

describe("Flowchart ↔ Code ↔ Chat", () => {
	it("shares the selected node, drops unsafe paths, and marks the map stale on edits", async () => {
		const { report, prompt, gui, scope, journal, project } = await workspace();
		gui.emit(scope, "flowchart", { type: "flowchart.generated", filesRead: 3 });
		await journal.flush();
		await report("flowchart", { type: "flowchart.node_selected", id: "reconnect", label: "Reconnect with backoff", file: "src/socket.ts",
			symbol: "reconnect", line: 42, relatedFiles: ["src/client.ts", "../outside.ts", ".env", path.join(project, "src/retry.ts")] });
		expect(gui.ui(scope).flowchart?.selectedNode).toEqual({ id: "reconnect", label: "Reconnect with backoff", file: "src/socket.ts", symbol: "reconnect", line: 42,
			relatedFiles: ["src/client.ts", "src/retry.ts"] });
		let context = (await prompt())!;
		expect(context).toContain('Flowchart:\n- Selected node: "Reconnect with backoff" — src/socket.ts:42 (reconnect); related: src/client.ts, src/retry.ts');
		expect(context).not.toContain("Out of date");

		await report("editor", { type: "file.changed", file: "src/socket.ts" });
		expect(gui.ui(scope).flowchart).toMatchObject({ stale: true, staleFiles: ["src/socket.ts"] });
		context = (await prompt())!;
		expect(context).toContain("- Out of date: src/socket.ts changed since it was generated. It is not regenerated automatically.");
		// A flowchart.generated event is the only thing that clears staleness; editing never regenerates.
		expect(gui.events(scope).filter(event => event.type === "flowchart.generated")).toHaveLength(1);

		await report("flowchart", { type: "flowchart.node_cleared" });
		expect((await prompt())!).not.toContain("Selected node");
	});

	it("rejects node paths outside the workspace and keeps credential nodes out of Chat", async () => {
		const { report, prompt, gui, scope } = await workspace();
		await expect(report("flowchart", { type: "flowchart.node_selected", id: "x", label: "X", file: "../other/app.ts" })).rejects.toThrow("outside the project");
		await report("flowchart", { type: "flowchart.node_selected", id: "env", label: "Load secrets", file: ".env" });
		expect(gui.ui(scope).flowchart?.selectedNode).toBeUndefined();
		expect(await prompt()).toBeUndefined();
	});
});

describe("Terminal ↔ Chat", () => {
	it("reports concise outcomes of the student's commands without secrets or full output", async () => {
		const { report, prompt, gui, scope } = await workspace();
		await prompt();
		await report("terminal", { type: "terminal.command_finished", command: "npm run dev", exitCode: 0, summary: "all output\nerror in the middle but it passed" });
		await report("terminal", { type: "terminal.command_finished", command: "curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz' https://api.example.com", exitCode: 0 });
		await report("terminal", { type: "terminal.command_finished", command: "node server.js", exitCode: 1,
			summary: `${"listening...\n".repeat(200)}Error: listen EADDRINUSE: address already in use :::3000\n    at Server.setupListenHandle\npassword=hunter2 failed` });
		const events = gui.events(scope);
		expect(events.find(event => event.type === "terminal.command_finished" && event.command === "npm run dev")).not.toHaveProperty("summary");
		expect(gui.ui(scope).terminal).toEqual({ lastCommand: "node server.js", lastExitCode: 1, actor: "student" });
		const context = (await prompt())!;
		expect(context).toContain("Student terminal:\n- `npm run dev` succeeded");
		expect(context).toContain("- `node server.js` exited with code 1");
		expect(context).toContain("Error: listen EADDRINUSE: address already in use :::3000");
		for (const hidden of ["ghp_", "hunter2", "listening..."]) expect(context).not.toContain(hidden);
	});

	it("does not let the GUI claim test results or agent actions directly", async () => {
		const { report } = await workspace();
		for (const type of ["test.failed", "test.passed", "agent.files_changed", "chat.prompted", "flowchart.generated", "budget.exhausted"]) {
			await expect(report("terminal", { type, command: "npm test", files: [{ file: "a.ts", kind: "modified" }] })).rejects.toThrow("not supported");
		}
	});

	it("keeps the agent's own commands separate from the student's terminal", async () => {
		const { fire, prompt, activity } = await workspace();
		await prompt();
		await fire("tool_call", { toolName: "bash", toolCallId: "1", input: { command: "ls -la" } });
		await fire("tool_result", { toolName: "bash", toolCallId: "1", isError: true, content: [{ type: "text", text: "ls: cannot access: denied\nCommand exited with code 2" }] });
		expect(activity.stream.ui(activity.scope()!).terminal).toMatchObject({ lastCommand: "ls -la", lastExitCode: 2, actor: "agent" });
		expect((await prompt()) ?? "").not.toContain("Student terminal");
	});
});

describe("workspace-aware chat context", () => {
	it("is built by one function from state, events and capabilities", () => {
		expect(buildWorkspaceChatContext({ ui: { openFiles: [], recentChanges: [] }, events: [] })).toBeUndefined();
		const context = buildWorkspaceChatContext({ ui: { openFiles: [], recentChanges: [] }, actions: [
			{ action: "agent-edit", available: false, reason: "model_cannot_use_tools" },
			{ action: "agent-run-command", available: false, reason: "sandbox_unavailable" },
		] })!;
		expect(context).toContain("You cannot edit files right now (model_cannot_use_tools). Explain the change and let the student make it in the editor.");
		expect(context).toContain("You cannot run commands right now (sandbox_unavailable).");
	});

	it("tells the model it cannot edit when policy disables agent editing", async () => {
		const project = await directory();
		const policy = { projectId: "project-a", version: 1, sourceVersions: { organization: 1 }, settings: { ...DEFAULT_CAPABILITY_POLICY, models: ["openai/small"], fileEditing: false } };
		const context = await resolveExecutionContext({ workspacePath: project, selection: { workspacePath: project, projectId: "project-a", classId: "class-a", organizationId: "org-a" },
			identityProvider: { getIdentity: async () => ({ kind: "student" as const, userId: "student-a" }) },
			scopeProvider: { resolve: vi.fn(async () => ({ projectId: "project-a", classId: "class-a", organizationId: "org-a", userId: "student-a" })) },
			policyProvider: { resolvePolicy: vi.fn(async () => policy) },
			environmentProvider: { resolve: vi.fn(async () => ({ sandbox: { mode: "gondolin" as const }, skills: [], mcps: [] })) } });
		const capabilities: WorkspaceCapabilityResolver = async observed => resolveStudentCapabilities(context, observed);
		const { prompt, report } = await workspace({ capabilities });
		await report("editor", { type: "file.opened", file: "src/a.ts" });
		expect(await prompt()).toContain("You cannot edit files right now (agent_editing_disabled)");
	});

	it("explains what still works when the model provider fails mid-session", async () => {
		const project = await directory();
		const context = await resolveExecutionContext({ workspacePath: project, selection: {},
			identityProvider: { getIdentity: async () => ({ kind: "student" as const }) }, policyProvider: { resolvePolicy: vi.fn(async () => undefined) } });
		const resolved: EffectiveStudentCapabilities[] = [];
		const { fire, notify } = await workspace({ capabilities: async observed => { const value = resolveStudentCapabilities(context, observed); resolved.push(value); return value; } });
		await fire("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "503 upstream" } });
		expect(resolved.at(-1)?.chat).toMatchObject({ allowed: false, code: "provider_unavailable" });
		const message = notify.mock.calls.at(-1)?.[0] as string;
		expect(message).toContain("The AI model is unavailable right now.");
		expect(message).toContain("- edit the code yourself");
		expect(message).toContain("- run tests");
		expect(message).not.toContain("ask for guidance");
		notify.mockClear();
		await fire("message_end", { message: { role: "assistant", stopReason: "stop" } });
		expect(notify).not.toHaveBeenCalled();
	});
});
