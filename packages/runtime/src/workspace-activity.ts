import path from "node:path";
import { isToolCallEventType, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EffectiveStudentCapabilities, NextAvailableAction, WorkspaceEventInput, WorkspaceMapStatus, WorkspaceSurface, WorkspaceUiState } from "@pi-student/contracts";
import type { WorkflowController } from "@pi-student/education/workflow-controller";
import { resolveLearnScaffolding } from "@pi-student/education/learn-scaffolding";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import { FileTeacherContextStore, type TeacherContextStore } from "@pi-student/telemetry/local-store";
import { formatAssistanceFallback, resolveNextAvailableActions } from "./assistance.js";
import type { StudentCapabilityInputs } from "./student-workspace.js";
import { buildQuestionWorkspaceContext } from "./question-workspace-context.js";
import { buildWorkspaceChatContext } from "./workspace-chat-context.js";
import { resolveWorkspaceEventScope, TEST_COMMAND, WorkspaceEventJournal, WorkspaceEventStream,
	workspaceEventKey, type WorkspaceEventScope } from "./workspace-events.js";
import { learningProgress } from "./workspace-snapshot.js";
import { WorkspaceMapStore } from "./workspace-map-store.js";

export type WorkspaceActivityEmitter = (source: WorkspaceSurface, event: WorkspaceEventInput) => void;

/** Resolves current capabilities, given what the session has observed about the model. */
export type WorkspaceCapabilityResolver = (observed: Pick<StudentCapabilityInputs, "model" | "exhausted">) => Promise<EffectiveStudentCapabilities | undefined>;

/**
 * Who this Chat is: the signed-in student (from the authorized ExecutionContext)
 * and the Pi session id. The student keys project state; the session keys
 * transient Chat state such as Learn, prompts, model health and budget.
 */
export type WorkspaceSessionIdentity = () => Promise<{ userId?: string; sessionId?: string }>;

export interface WorkspaceActivity {
	extension: ExtensionFactory;
	emit: WorkspaceActivityEmitter;
	stream: WorkspaceEventStream;
	scope(): WorkspaceEventScope | undefined;
	/** Deterministic next actions for the current workspace, or undefined when capabilities are unknown. */
	actions(observed?: Pick<StudentCapabilityInputs, "model" | "exhausted">): Promise<NextAvailableAction[] | undefined>;
}

/**
 * Connects the chat session to the shared workspace event stream: it records
 * agent edits, commands, tests, model and policy changes, and gives the model a
 * short metadata summary of what other surfaces did. It never forwards file
 * contents, prompts, or full command output.
 */
export function createWorkspaceActivity(workflow: WorkflowController, sandbox: SandboxRuntime,
	options: { stream?: WorkspaceEventStream; contextStore?: TeacherContextStore; capabilities?: WorkspaceCapabilityResolver; identity?: WorkspaceSessionIdentity;
		maps?: WorkspaceMapStore } = {}): WorkspaceActivity {
	const stream = options.stream ?? new WorkspaceEventStream({ journal: new WorkspaceEventJournal() });
	const maps = options.maps ?? new WorkspaceMapStore();
	/** Current UI state, with the persisted map (and its on-disk staleness) as the authority for the flowchart. */
	const currentUi = async (): Promise<WorkspaceUiState> => withMap(stream.ui(scope!), await maps.status(scope!).catch(() => undefined));
	const contextStore = options.contextStore ?? new FileTeacherContextStore();
	let scope: WorkspaceEventScope | undefined;
	let capabilities: Record<string, string> | undefined;
	let exhausted: string | undefined;
	let agentExhausted: string | undefined;
	// What this session last told other surfaces about its model and learning progress.
	let modelAvailable: boolean | undefined;
	let progress: string | undefined;
	const pending = new Map<string, { file?: string; existed: boolean; command?: string; test: boolean }>();
	const emit: WorkspaceActivityEmitter = (source, event) => {
		if (!scope) return;
		try { stream.emit(scope, source, event); } catch { /* Activity is best-effort metadata. */ }
	};
	const capabilitySnapshot = () => Object.fromEntries(Object.entries(capabilityState(workflow).settings).map(([key, value]) => [key, JSON.stringify(value)]));
	const publishProgress = () => {
		const next = learningProgress(workflow.state);
		const key = JSON.stringify(next);
		if (!scope || key === progress) return;
		progress = key;
		emit("chat", { type: "learning.progress", ...next });
	};
	const bind = async () => {
		const identity = await options.identity?.().catch(() => ({})) ?? {};
		const next = await resolveWorkspaceEventScope(workflow.state.cwd, await contextStore.read().catch(() => ({})), identity);
		const moved = scope && (workspaceEventKey(scope) !== workspaceEventKey(next) || scope.sessionId !== next.sessionId);
		// Editor selections, test failures and file lists from the previous project or student must not follow this Chat.
		if (moved) {
			stream.forget(scope!);
			pending.clear();
			exhausted = undefined;
			agentExhausted = undefined;
			modelAvailable = undefined;
			progress = undefined;
		}
		scope = next;
		await stream.refresh(scope).catch(() => {});
		const current = capabilitySnapshot();
		const changed = moved ? ["project"] : capabilities ? Object.keys(current).filter(key => current[key] !== capabilities![key]) : [];
		capabilities = current;
		if (changed.length) emit("runtime", { type: "capability.changed", changed });
		// Tell Code, Map and Terminal which Learn setting this chat uses in this project. Never copied from the previous project.
		const learnMode = workflow.state.learnMode === true;
		if ((stream.ui(scope).learn?.enabled ?? false) !== learnMode) emit("learn", { type: learnMode ? "learn.enabled" : "learn.disabled" });
		publishProgress();
	};
	const actions = async (observed: Pick<StudentCapabilityInputs, "model" | "exhausted"> = {}) => {
		const capabilities = await options.capabilities?.(observed).catch(() => undefined);
		return capabilities && resolveNextAvailableActions({ capabilities, ui: scope ? stream.ui(scope) : { openFiles: [], recentChanges: [] } });
	};
	const relative = (file: unknown) => {
		if (typeof file !== "string" || !scope) return undefined;
		const root = sandbox.getWorkspacePath();
		const inside = path.posix.relative(root, path.posix.resolve(root, file));
		return inside && !inside.startsWith("..") && !path.posix.isAbsolute(inside) ? inside : undefined;
	};

	const extension: ExtensionFactory = pi => {
		const unsubscribe = workflow.onChange(() => {
			if (!scope) return;
			const enabled = workflow.state.learnMode === true;
			if (enabled !== (stream.ui(scope).learn?.enabled ?? false)) emit("learn", { type: enabled ? "learn.enabled" : "learn.disabled" });
			publishProgress();
		});
		pi.on("session_start", async () => { await bind(); });
		pi.on("before_agent_start", async event => {
			await bind();
			const learnMode = workflow.state.learnMode === true;
			// Build before recording this prompt, so "since the previous AI turn" ends here.
			// A /question turn gets the student's current work instead, so the question is about what they are doing.
			const question = workflow.state.question?.phase === "generate";
			const state = workflow.state;
			const ui = scope && await currentUi();
			const summary = scope && ui && (question
				? buildQuestionWorkspaceContext({ ui, stage: state.stage, goal: state.goal, plan: state.plan })
				: buildWorkspaceChatContext({ ui, events: stream.events(scope), actions: await actions(), learn: resolveLearnScaffolding(learnMode) }));
			emit("chat", { type: "chat.prompted", learnMode });
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
				// Agent commands come from the chat surface; the student's own terminal reports as "terminal".
				emit("chat", { type: "terminal.command_started", command });
				if (test) emit("chat", { type: "test.started", command });
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
				emit("chat", { type: "terminal.command_finished", command: call.command, ...code, ...(event.isError ? { summary: output.slice(-20_000) } : {}) });
				if (call.test) emit("chat", event.isError
					? { type: "test.failed", command: call.command, ...code, summary: output.slice(-20_000) }
					: { type: "test.passed", command: call.command, ...code });
			}
		});
		pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "assistant") return;
			const state = capabilityState(workflow);
			const reached = state.limitReached();
			const agentReached = state.agentLimitReached();
			const notify = async (observed: Pick<StudentCapabilityInputs, "model" | "exhausted">, cause: string) => {
				const message = formatAssistanceFallback(await actions(observed) ?? [], cause);
				if (message) ctx?.ui?.notify(message, "warning");
			};
			const allClosed = Boolean(reached && reached !== exhausted);
			const agentClosed = Boolean(!reached && agentReached && agentReached !== agentExhausted);
			if (allClosed) {
				emit("runtime", { type: "budget.exhausted", reason: reached! });
				await notify({}, reached!);
			} else if (agentClosed) {
				emit("runtime", { type: "budget.exhausted", reason: agentReached!, lane: "agent" });
			}
			// Publish model health so Code, Map and progress stop offering AI help Chat cannot give, and offer it again once Chat recovers.
			const failed = (event.message as { stopReason?: string }).stopReason === "error";
			if (failed || modelAvailable === false) {
				if (modelAvailable !== !failed) emit("chat", { type: "model.health", available: !failed });
				modelAvailable = !failed;
			}
			// A provider failure ends AI help for now, not the student's work.
			if (failed && !allClosed && !agentClosed) await notify({ model: { available: false } }, "");
			exhausted = reached;
			agentExhausted = agentReached;
		});
		pi.on("session_shutdown", async () => { unsubscribe(); });
	};
	return { extension, emit, stream, scope: () => scope, actions };
}

function withMap(ui: WorkspaceUiState, map: WorkspaceMapStatus | undefined): WorkspaceUiState {
	if (!map?.available) return ui;
	const selectedNode = ui.flowchart?.selectedNode ?? map.selectedNode;
	return { ...ui, flowchart: { generatedAt: map.generatedAt, stale: map.stale, staleFiles: map.staleFiles, ...(selectedNode ? { selectedNode } : {}) } };
}
