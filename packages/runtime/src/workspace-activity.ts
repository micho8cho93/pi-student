import path from "node:path";
import { isToolCallEventType, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { WorkspaceEventInput, WorkspaceSurface } from "@pi-student/contracts";
import type { WorkflowController } from "@pi-student/education/workflow-controller";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import { FileTeacherContextStore, type TeacherContextStore } from "@pi-student/telemetry/local-store";
import { describeWorkspaceActivity, resolveWorkspaceEventScope, TEST_COMMAND, WorkspaceEventJournal, WorkspaceEventStream,
	workspaceEventKey, type WorkspaceEventScope } from "./workspace-events.js";

export type WorkspaceActivityEmitter = (source: WorkspaceSurface, event: WorkspaceEventInput) => void;

export interface WorkspaceActivity {
	extension: ExtensionFactory;
	emit: WorkspaceActivityEmitter;
	stream: WorkspaceEventStream;
	scope(): WorkspaceEventScope | undefined;
}

/**
 * Connects the chat session to the shared workspace event stream: it records
 * agent edits, commands, tests, model and policy changes, and gives the model a
 * short metadata summary of what other surfaces did. It never forwards file
 * contents, prompts, or full command output.
 */
export function createWorkspaceActivity(workflow: WorkflowController, sandbox: SandboxRuntime,
	options: { stream?: WorkspaceEventStream; contextStore?: TeacherContextStore } = {}): WorkspaceActivity {
	const stream = options.stream ?? new WorkspaceEventStream({ journal: new WorkspaceEventJournal() });
	const contextStore = options.contextStore ?? new FileTeacherContextStore();
	let scope: WorkspaceEventScope | undefined;
	let capabilities: Record<string, string> | undefined;
	let learnMode = workflow.state.learnMode === true;
	let exhausted: string | undefined;
	const emit: WorkspaceActivityEmitter = (source, event) => {
		if (!scope) return;
		try { stream.emit(scope, source, event); } catch { /* Activity is best-effort metadata. */ }
	};
	const capabilitySnapshot = () => Object.fromEntries(Object.entries(capabilityState(workflow).settings).map(([key, value]) => [key, JSON.stringify(value)]));
	const bind = async () => {
		const next = await resolveWorkspaceEventScope(workflow.state.cwd, await contextStore.read().catch(() => ({})));
		const moved = scope && workspaceEventKey(scope) !== workspaceEventKey(next);
		// Editor selections, test failures and file lists from the previous project must not follow the student.
		if (moved) stream.forget(scope!);
		scope = next;
		await stream.refresh(scope).catch(() => {});
		const current = capabilitySnapshot();
		const changed = moved ? ["project"] : capabilities ? Object.keys(current).filter(key => current[key] !== capabilities![key]) : [];
		capabilities = current;
		if (changed.length) emit("runtime", { type: "capability.changed", changed });
	};
	const relative = (file: unknown) => {
		if (typeof file !== "string" || !scope) return undefined;
		const root = sandbox.getWorkspacePath();
		const inside = path.posix.relative(root, path.posix.resolve(root, file));
		return inside && !inside.startsWith("..") && !path.posix.isAbsolute(inside) ? inside : undefined;
	};

	const extension: ExtensionFactory = pi => {
		const pending = new Map<string, { file?: string; existed: boolean; command?: string; test: boolean }>();
		const unsubscribe = workflow.onChange(() => {
			const enabled = workflow.state.learnMode === true;
			if (enabled === learnMode) return;
			learnMode = enabled;
			emit("learn", { type: enabled ? "learn.enabled" : "learn.disabled" });
		});
		pi.on("session_start", async () => { await bind(); });
		pi.on("before_agent_start", async event => {
			await bind();
			emit("chat", { type: "chat.prompted", learnMode });
			const summary = scope && describeWorkspaceActivity(stream.ui(scope));
			return summary ? { systemPrompt: `${event.systemPrompt}\n\n${summary}` } : undefined;
		});
		pi.on("model_select", async event => { emit("chat", { type: "model.changed", model: `${event.model.provider}/${event.model.id}` }); });
		pi.on("tool_call", async event => {
			if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				pending.set(event.toolCallId, { file: relative(event.input.path), existed: await sandbox.fileExists(event.input.path).catch(() => true), test: false });
			}
			if (isToolCallEventType("bash", event)) {
				const command = event.input.command.trim();
				const test = TEST_COMMAND.test(command);
				pending.set(event.toolCallId, { command, existed: false, test });
				emit("terminal", { type: "terminal.command_started", command });
				if (test) emit("terminal", { type: "test.started", command });
			}
		});
		pi.on("tool_result", async event => {
			const call = pending.get(event.toolCallId);
			pending.delete(event.toolCallId);
			if (!call) return;
			if (call.file && !event.isError) emit("chat", { type: "agent.files_changed", files: [{ file: call.file, kind: call.existed ? "modified" : "created" }] });
			if (call.command) {
				const output = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
				const exitCode = event.isError ? Number(output.match(/Command exited with code (\d+)/)?.[1] ?? NaN) : 0;
				const code = Number.isSafeInteger(exitCode) ? { exitCode } : {};
				emit("terminal", { type: "terminal.command_finished", command: call.command, ...code });
				if (call.test) emit("terminal", event.isError
					? { type: "test.failed", command: call.command, ...code, summary: output.slice(-20_000) }
					: { type: "test.passed", command: call.command, ...code });
			}
		});
		pi.on("message_end", async event => {
			if (event.message.role !== "assistant") return;
			const reached = capabilityState(workflow).limitReached();
			if (reached && reached !== exhausted) emit("runtime", { type: "budget.exhausted", reason: reached });
			exhausted = reached;
		});
		pi.on("session_shutdown", async () => { unsubscribe(); });
	};
	return { extension, emit, stream, scope: () => scope };
}
