import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceEvent, WorkspaceEventInput, WorkspaceEventType, WorkspaceFileChange, WorkspaceScope,
	WorkspaceSessionState, WorkspaceSurface, WorkspaceUiState } from "@pi-student/contracts";
import { isLearningStage } from "@pi-student/education/stage";
import { isSensitiveContextPath } from "@pi-student/shared/file-context";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";
import { redactSensitiveText } from "@pi-student/telemetry/privacy";
import type { TeacherContext } from "@pi-student/telemetry/types";

/**
 * The identity an event stream is keyed by. Derived from the authorized project and
 * signed-in student, never from UI input. `sessionId` selects which Chat session's
 * transient state a reader sees; it is not part of the storage key.
 */
export type WorkspaceEventScope = Pick<WorkspaceScope, "projectPath" | "projectId" | "organizationId" | "userId" | "sessionId">;

/**
 * Events that describe one Chat session rather than the project. They carry the
 * emitting session and are only visible to readers of that session: two Chats in
 * one project never share Learn, "since the previous AI turn", model health,
 * session budget or learning progress. Everything else (files, editor, tests,
 * terminal, map, project policy) is project-scoped and shared.
 *
 * Invariant: a session-scoped event requires a valid session id. Without one it is
 * rejected on emit and dropped on replay; it is never stored under an empty or
 * default session, and a session-less reader never sees it.
 */
export const SESSION_SCOPED_EVENTS: ReadonlySet<WorkspaceEventType> = new Set<WorkspaceEventType>(["chat.prompted", "learn.enabled", "learn.disabled",
	"question.completed", "model.changed", "model.health", "budget.warning", "budget.exhausted", "learning.progress"]);

const SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export const TEST_COMMAND = /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint))\b|^(?:npx\s+)?(?:vitest|jest|pytest|mocha)\b|^(?:cargo|go)\s+test\b|^python3?\s+-m\s+(?:pytest|unittest)\b/i;

export const FLOWCHART_IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "build", "coverage", "vendor", "venv", ".venv", "target", "__pycache__", ".cache"]);
export const FLOWCHART_SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|cs|php|vue|astro|svelte|html|css|scss|sql|json|ya?ml|toml|sh)$/i;
export const FLOWCHART_IMPORTANT_NAME = /^(?:README(?:\.md)?|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|requirements\.txt|Dockerfile|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s)$/i;
export const FLOWCHART_EXCLUDED_NAME = /(?:\.lock|lock\.json|\.min\.js|\.map|\.svg|\.snap)/i;

/** Whether a project-relative file is one the flowchart generator reads. */
export function isFlowchartSourceFile(relative: string): boolean {
	const parts = relative.split("/");
	const name = parts.at(-1) ?? "";
	if (parts.some(part => part.startsWith(".")) || parts.slice(0, -1).some(part => FLOWCHART_IGNORED_DIRECTORIES.has(part))) return false;
	if (isSensitiveContextPath(relative) || FLOWCHART_EXCLUDED_NAME.test(name)) return false;
	return FLOWCHART_SOURCE_EXTENSION.test(name) || FLOWCHART_IMPORTANT_NAME.test(name);
}

/** Storage key for a student's project. Two students, or two projects, never share a key; sessions of one student do. */
export function workspaceEventKey(scope: WorkspaceEventScope): string {
	// userId is appended only when known, so personal (signed-out) workspaces keep their existing keys.
	return createHash("sha256").update(JSON.stringify([path.resolve(scope.projectPath), scope.projectId ?? null, scope.organizationId ?? null,
		...(scope.userId ? [scope.userId] : [])])).digest("hex");
}

const validSession = (sessionId: unknown): sessionId is string => typeof sessionId === "string" && SESSION_ID.test(sessionId);

/** Whether a reader bound to `sessionId` may see an event. Project events are visible to every session; session events only to their own. */
export function visibleToSession(event: Pick<WorkspaceEvent, "type" | "session">, sessionId: string | undefined): boolean {
	return !SESSION_SCOPED_EVENTS.has(event.type) || (validSession(sessionId) && event.session === sessionId);
}

/**
 * A managed (class) workspace whose student could not be resolved by the trusted
 * identity layer. Its state is unavailable: nothing is read, written or shown, and
 * it never falls back to a personal, anonymous or previously signed-in student's state.
 */
export class WorkspaceIdentityRequiredError extends Error {
	readonly code = "identity_required";
	constructor() { super("Sign in to your class account to use this project's workspace activity. Your files, editor and terminal still work."); }
}

/**
 * Both the GUI bridge and the chat runtime derive the same scope from the
 * stored class selection, which only applies to the workspace it was bound to.
 * `identity.userId` must come from the authenticated control plane. A personal
 * workspace is valid without it; a managed one fails closed.
 */
export async function resolveWorkspaceEventScope(projectPath: string, selection: TeacherContext = {},
	identity: { userId?: string; sessionId?: string } = {}): Promise<WorkspaceEventScope> {
	const resolved = await realpath(projectPath);
	const bound = selection.projectId && selection.workspacePath && await realpath(selection.workspacePath).catch(() => undefined) === resolved;
	if (identity.sessionId !== undefined && !validSession(identity.sessionId)) throw new Error("Workspace session identifier is invalid.");
	if (bound && !identity.userId) throw new WorkspaceIdentityRequiredError();
	return { projectPath: resolved, ...(bound ? { projectId: selection.projectId, organizationId: selection.organizationId } : {}),
		...(identity.userId ? { userId: identity.userId } : {}), ...(identity.sessionId ? { sessionId: identity.sessionId } : {}) };
}

const MAX_COMMAND = 200;
const MAX_SUMMARY = 800;
const MAX_REASON = 300;
const MAX_FILES = 20;

const text = (value: unknown, max: number) => typeof value === "string" ? redactSensitiveText(value.replace(/\s+/g, " ").trim()).slice(0, max) : "";
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;

/** Keeps a few failing lines from command or test output, redacted and without credential-like paths. */
export function summarizeFailureOutput(output: string): string | undefined {
	const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
		.filter(line => !mentionsSensitivePath(line))
		.filter(line => /\b(?:fail(?:ed|ing|ure)?|error|expected|received|assert\w*|exception|traceback|not found|denied|cannot|unable)\b|✗|×|✕/i.test(line) && !/^Command exited with code/.test(line));
	let summary = "";
	for (const line of lines.slice(0, 8)) {
		const next = `${summary}${summary ? "\n" : ""}${redactSensitiveText(line).slice(0, 200)}`;
		if (next.length > MAX_SUMMARY) break;
		summary = next;
	}
	return summary || undefined;
}

const mentionsSensitivePath = (line: string) => line.split(/[\s'"`():,]+/).some(token => /[./]/.test(token) && isSensitiveContextPath(token));

const FAILED_TEST_PATTERNS = [
	// vitest / jest: "FAIL  src/socket/reconnect.test.ts > reconnects"
	/^(?:FAIL|✗|×|✕)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?(?:\s+>\s+[^\n]+)?)/,
	// pytest: "FAILED tests/test_socket.py::test_reconnect - AssertionError"
	/^FAILED\s+(\S+?)(?:\s+-\s.*)?$/,
	// go: "--- FAIL: TestReconnect (0.01s)"
	/^--- FAIL:\s+(\S+)/,
	// cargo: "test socket::reconnect ... FAILED"
	/^test\s+(\S+)\s+\.\.\.\s+FAILED$/,
];

/** Detects failing test files or names in test output. Returns at most five short, redacted names. */
export function detectFailedTests(output: string): string[] | undefined {
	const names = new Set<string>();
	for (const raw of output.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || mentionsSensitivePath(line)) continue;
		for (const pattern of FAILED_TEST_PATTERNS) {
			const name = line.match(pattern)?.[1];
			if (name) { names.add(redactSensitiveText(name).slice(0, 160)); break; }
		}
		if (names.size >= 5) break;
	}
	return names.size ? [...names] : undefined;
}

const EVENT_TYPES: ReadonlySet<WorkspaceEventType> = new Set<WorkspaceEventType>(["file.opened", "file.changed", "editor.selection_changed", "autocomplete.accepted",
	"terminal.command_started", "terminal.command_finished", "test.started", "test.passed", "test.failed", "flowchart.generated", "flowchart.stale",
	"flowchart.node_selected", "flowchart.node_cleared", "chat.prompted", "agent.files_changed", "learn.enabled", "learn.disabled", "question.completed", "model.changed", "budget.warning",
	"budget.exhausted", "capability.changed", "model.health", "learning.progress"]);

/** Events the GUI may report on the student's behalf, and the surface each one comes from. */
const STUDENT_EVENT_SURFACES: ReadonlyMap<WorkspaceEventType, WorkspaceSurface> = new Map<WorkspaceEventType, WorkspaceSurface>([
	["file.opened", "editor"], ["file.changed", "editor"], ["editor.selection_changed", "editor"], ["autocomplete.accepted", "editor"],
	["terminal.command_finished", "terminal"],
	["flowchart.node_selected", "flowchart"], ["flowchart.node_cleared", "flowchart"],
]);
export const STUDENT_SURFACE_EVENTS: ReadonlySet<WorkspaceEventType> = new Set(STUDENT_EVENT_SURFACES.keys());

/** The surface a student-reported event belongs to; undefined when the GUI may not report it. */
export function studentEventSurface(value: unknown): WorkspaceSurface | undefined {
	const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
	return typeof type === "string" ? STUDENT_EVENT_SURFACES.get(type as WorkspaceEventType) : undefined;
}

/**
 * Validates untrusted input (GUI requests, journal lines) and reduces it to
 * bounded metadata. Files must be inside the project; paths become project-relative.
 */
export function parseWorkspaceEventInput(projectPath: string, value: unknown, allowed: ReadonlySet<WorkspaceEventType> = EVENT_TYPES): WorkspaceEventInput & { sensitive?: true } {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace event is invalid.");
	const raw = value as Record<string, unknown>;
	const type = raw.type as WorkspaceEventType;
	if (!EVENT_TYPES.has(type) || !allowed.has(type)) throw new Error("Workspace event type is not supported.");
	let sensitive = false;
	const file = (candidate: unknown) => {
		if (typeof candidate !== "string" || !candidate || candidate.length > 2_000 || candidate.includes("\0")) throw new Error("Workspace event file is invalid.");
		const relative = path.relative(projectPath, path.resolve(projectPath, candidate));
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Workspace event file is outside the project.");
		const normalized = relative.split(path.sep).join("/");
		if (isSensitiveContextPath(normalized)) sensitive = true;
		return normalized;
	};
	const command = () => {
		const value = text(raw.command, MAX_COMMAND);
		if (!value) throw new Error("Workspace event command is invalid.");
		return value;
	};
	const reason = () => text(raw.reason, MAX_REASON) || "Limit reached.";
	const failure = () => {
		const summary = typeof raw.summary === "string" ? summarizeFailureOutput(raw.summary) : undefined;
		return summary ? { summary } : {};
	};
	const exitCode = Number.isSafeInteger(raw.exitCode) ? { exitCode: raw.exitCode as number } : {};
	let event: WorkspaceEventInput;
	switch (type) {
		case "file.opened": case "file.changed": case "autocomplete.accepted": event = { type, file: file(raw.file) }; break;
		case "editor.selection_changed": {
			const startLine = count(raw.startLine), endLine = count(raw.endLine);
			if (!startLine || !endLine || endLine < startLine) throw new Error("Workspace event selection is invalid.");
			event = { type, file: file(raw.file), startLine, endLine }; break;
		}
		case "terminal.command_started": case "test.started": event = { type, command: command() }; break;
		case "terminal.command_finished": event = { type, command: command(), ...exitCode, ...(exitCode.exitCode ? failure() : {}) }; break;
		case "test.passed": event = { type, command: command(), ...exitCode }; break;
		case "test.failed": {
			const failedTests = Array.isArray(raw.failedTests)
				? raw.failedTests.filter((item): item is string => typeof item === "string" && !mentionsSensitivePath(item)).slice(0, 5).map(item => text(item, 160)).filter(Boolean)
				: typeof raw.summary === "string" ? detectFailedTests(raw.summary) : undefined;
			event = { type, command: command(), ...exitCode, ...failure(), ...(failedTests?.length ? { failedTests } : {}) }; break;
		}
		case "flowchart.generated": event = { type, filesRead: count(raw.filesRead) ?? 0, ...(raw.model ? { model: text(raw.model, 210) } : {}) }; break;
		case "flowchart.stale": {
			if (!Array.isArray(raw.files)) throw new Error("Workspace event files are invalid.");
			event = { type, files: raw.files.slice(0, MAX_FILES).map(file) }; break;
		}
		case "flowchart.node_selected": {
			const id = text(raw.id, 80), label = text(raw.label, 100);
			if (!id || !label) throw new Error("Workspace event flowchart node is invalid.");
			const line = count(raw.line);
			const symbol = typeof raw.symbol === "string" && /^[\w$.#:<>\-]{1,120}$/.test(raw.symbol) ? raw.symbol : undefined;
			// Related files are optional context: drop unsafe ones instead of rejecting the selection.
			const relatedFiles = Array.isArray(raw.relatedFiles) ? raw.relatedFiles.slice(0, 10).flatMap(item => {
				try { const related = path.relative(projectPath, path.resolve(projectPath, String(item))).split(path.sep).join("/");
					return typeof item === "string" && related && !related.startsWith("..") && !path.isAbsolute(related) && !isSensitiveContextPath(related) ? [related] : []; }
				catch { return []; }
			}) : [];
			event = { type, id, label, ...(raw.file === undefined ? {} : { file: file(raw.file) }), ...(symbol ? { symbol } : {}),
				...(line ? { line } : {}), ...(relatedFiles.length ? { relatedFiles } : {}) }; break;
		}
		case "flowchart.node_cleared": event = { type }; break;
		case "chat.prompted": event = { type, learnMode: raw.learnMode === true }; break;
		case "agent.files_changed": {
			if (!Array.isArray(raw.files) || !raw.files.length) throw new Error("Workspace event files are invalid.");
			event = { type, files: raw.files.slice(0, MAX_FILES).map(item => {
				const kind = (item as { kind?: unknown })?.kind;
				if (kind !== "created" && kind !== "modified" && kind !== "deleted") throw new Error("Workspace event file change is invalid.");
				return { file: file((item as { file?: unknown }).file), kind };
			}) }; break;
		}
		case "learn.enabled": case "learn.disabled": event = { type }; break;
		case "question.completed": event = { type, difficulty: text(raw.difficulty, 20) || "medium", topic: text(raw.topic, 120) || "this repository" }; break;
		case "model.changed": event = { type, model: text(raw.model, 210) || "unknown" }; break;
		case "budget.warning": event = { type, reason: reason() }; break;
		case "budget.exhausted": event = { type, reason: reason(), ...(raw.lane === "agent" ? { lane: "agent" as const } : {}) }; break;
		case "capability.changed": {
			if (!Array.isArray(raw.changed)) throw new Error("Workspace event capabilities are invalid.");
			event = { type, changed: raw.changed.filter((item): item is string => typeof item === "string").slice(0, 30).map(item => item.slice(0, 60)) }; break;
		}
		case "model.health": {
			if (typeof raw.available !== "boolean") throw new Error("Workspace event model health is invalid.");
			const health = raw.health as { status?: unknown } | undefined;
			if (health && (!["available", "provider_unavailable", "model_unavailable", "authentication_failure", "transient_failure"].includes(String(health.status)) || raw.available !== (health.status === "available"))) throw new Error("Workspace model health status is invalid.");
			event = { type, available: raw.available, ...(health ? { health: { status: health.status } as import("@pi-student/contracts").WorkspaceModelHealth } : {}), ...(typeof raw.toolUse === "boolean" ? { toolUse: raw.toolUse } : {}) }; break;
		}
		case "learning.progress": {
			if (!isLearningStage(raw.stage)) throw new Error("Workspace event learning stage is invalid.");
			const goal = text(raw.goal, 160), activeStep = text(raw.activeStep, 160);
			event = { type, stage: raw.stage, ...(goal ? { goal } : {}), ...(activeStep ? { activeStep } : {}), understandingReady: raw.understandingReady === true,
				planApproved: raw.planApproved === true, verificationPassed: raw.verificationPassed === true }; break;
		}
	}
	return sensitive ? { ...event, sensitive: true } : event;
}

/** Applies one session-scoped event to that session's transient state. */
export function reduceSessionState(state: WorkspaceSessionState, event: WorkspaceEvent): WorkspaceSessionState {
	switch (event.type) {
		// Every chat prompt restates Learn, so Code, Map and Terminal converge on the setting Chat actually used.
		case "learn.enabled": case "learn.disabled": case "chat.prompted": {
			const enabled = event.type === "chat.prompted" ? event.learnMode : event.type === "learn.enabled";
			const learn = state.learn?.enabled === enabled ? state.learn : { enabled, at: event.at };
			return event.type === "chat.prompted" ? { ...state, learn, lastPromptAt: event.at } : { ...state, learn };
		}
		case "model.changed": return { ...state, model: { selected: event.model, at: event.at } };
		case "model.health": return { ...state, model: { ...state.model, available: event.available, health: event.health, ...(event.toolUse === undefined ? {} : { toolUse: event.toolUse }), at: event.at } };
		case "budget.warning": return { ...state, budget: { ...state.budget, warning: { reason: event.reason, at: event.at } } };
		case "budget.exhausted": {
			// An "all" exhaustion is never downgraded by a later agent-only notice.
			const lane = event.lane === "agent" && state.budget?.exhausted?.lane !== "all" ? "agent" as const : "all" as const;
			return { ...state, budget: { ...state.budget, exhausted: { reason: event.reason, lane, at: event.at } } };
		}
		case "learning.progress": {
			const { type: _type, seq: _seq, at, workspace: _workspace, source: _source, origin: _origin, session: _session, sensitive: _sensitive, ...progress } = event;
			return { ...state, progress: { ...progress, at } };
		}
		default: return state;
	}
}

/** Applies one event to transient UI state. Returns files that newly made the flowchart stale. */
export function reduceWorkspaceUi(ui: WorkspaceUiState, event: WorkspaceEvent): { ui: WorkspaceUiState; stale: string[] } {
	const changes = (items: Array<Omit<WorkspaceFileChange, "at">>) => {
		const visible = items.filter(item => !isSensitiveContextPath(item.file));
		if (!visible.length) return { ui, stale: [] };
		const replaced = new Set(visible.map(item => `${item.author}:${item.file}`));
		const recentChanges = [...ui.recentChanges.filter(item => !replaced.has(`${item.author}:${item.file}`)), ...visible.map(item => ({ ...item, at: event.at }))].slice(-MAX_FILES);
		const sources = visible.map(item => item.file).filter(isFlowchartSourceFile);
		if (!ui.flowchart?.generatedAt || !sources.length) return { ui: { ...ui, recentChanges }, stale: [] };
		const previous = ui.flowchart.staleFiles ?? [];
		const staleFiles = [...new Set([...previous, ...sources])].slice(0, MAX_FILES);
		return { ui: { ...ui, recentChanges, flowchart: { ...ui.flowchart, stale: true, staleFiles } }, stale: ui.flowchart.stale ? [] : sources };
	};
	if (event.sensitive && event.type !== "agent.files_changed") return { ui, stale: [] };
	// The student's own terminal reports through the terminal surface; the agent's commands through chat.
	const actor = event.source === "terminal" ? "student" as const : "agent" as const;
	switch (event.type) {
		case "file.opened": return { ui: { ...ui, activeFile: event.file, openFiles: [...ui.openFiles.filter(file => file !== event.file), event.file].slice(-MAX_FILES) }, stale: [] };
		case "file.changed": return changes([{ file: event.file, kind: "modified", author: "student" }]);
		case "autocomplete.accepted": return changes([{ file: event.file, kind: "modified", author: "autocomplete" }]);
		case "agent.files_changed": return changes(event.files.map(item => ({ ...item, author: "agent" as const })));
		case "editor.selection_changed": return { ui: { ...ui, selectedCode: { file: event.file, startLine: event.startLine, endLine: event.endLine } }, stale: [] };
		case "terminal.command_started": return { ui: { ...ui, terminal: { lastCommand: event.command, actor } }, stale: [] };
		case "terminal.command_finished": return { ui: { ...ui, terminal: { lastCommand: event.command, ...(event.exitCode === undefined ? {} : { lastExitCode: event.exitCode }), actor } }, stale: [] };
		case "test.passed": case "test.failed": return { ui: { ...ui, tests: { lastRun: { command: event.command, passed: event.type === "test.passed",
			...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }), ...(event.type === "test.failed" && event.summary ? { summary: event.summary } : {}),
			...(event.type === "test.failed" && event.failedTests ? { failedTests: event.failedTests } : {}), actor, at: event.at } } }, stale: [] };
		case "flowchart.node_selected": {
			const { type: _type, seq: _seq, at: _at, workspace: _workspace, source: _source, origin: _origin, session: _session, sensitive: _sensitive, ...selectedNode } = event;
			return { ui: { ...ui, flowchart: { ...(ui.flowchart ?? { stale: false }), selectedNode } }, stale: [] };
		}
		case "flowchart.node_cleared": {
			if (!ui.flowchart?.selectedNode) return { ui, stale: [] };
			const { selectedNode: _selected, ...flowchart } = ui.flowchart;
			return { ui: { ...ui, flowchart }, stale: [] };
		}
		case "flowchart.generated": return { ui: { ...ui, flowchart: { generatedAt: event.at, stale: false } }, stale: [] };
		// Session-scoped events (Learn, prompts, model, budget, progress) are reduced by reduceSessionState.
		case "flowchart.stale": return ui.flowchart?.generatedAt
			? { ui: { ...ui, flowchart: { ...ui.flowchart, stale: true, staleFiles: [...new Set([...(ui.flowchart.staleFiles ?? []), ...event.files])].slice(0, MAX_FILES) } }, stale: [] }
			: { ui, stale: [] };
		default: return { ui, stale: [] };
	}
}

/** Append-only local journal so the GUI bridge and chat runtime processes see each other's activity. Metadata only. */
export class WorkspaceEventJournal {
	private writes: Promise<void> = Promise.resolve();
	constructor(readonly directory = path.join(getInstallationPaths().config, "workspace-events"), private readonly maxBytes = 256_000) {}

	private file(key: string) {
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Workspace event key is invalid.");
		return path.join(this.directory, `${key}.jsonl`);
	}

	append(event: WorkspaceEvent): Promise<void> {
		this.writes = this.writes.then(async () => {
			const file = this.file(event.workspace);
			await mkdir(this.directory, { recursive: true, mode: 0o700 });
			await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
			if ((await stat(file)).size <= this.maxBytes) return;
			const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
			const temporary = `${file}.${randomUUID()}.tmp`;
			await writeFile(temporary, `${lines.slice(-Math.floor(lines.length / 2)).join("\n")}\n`, { mode: 0o600 });
			await rename(temporary, file);
		}).catch(() => { /* Activity is best-effort; it never blocks the student's work. */ });
		return this.writes;
	}

	async read(key: string): Promise<unknown[]> {
		let content: string;
		try { content = await readFile(this.file(key), "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		return content.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as unknown]; } catch { return []; } });
	}

	flush(): Promise<void> { return this.writes; }
}

export type WorkspaceEventListener = (event: Readonly<WorkspaceEvent>) => void;

interface WorkspaceRecord {
	scope: WorkspaceEventScope;
	events: WorkspaceEvent[];
	/** Project-scoped UI state, shared by every session. Session fields (learn) live in `sessions`. */
	ui: WorkspaceUiState;
	/** Keyed by session id. Session-scoped events without a session are never stored. */
	sessions: Map<string, WorkspaceSessionState>;
	seen: Set<string>;
}

/**
 * In-process workspace event stream. Events are keyed by the student's project and
 * never delivered across keys; session-scoped events are additionally visible only
 * to readers of the emitting session. Listeners receive events in emission order,
 * including events emitted by other listeners.
 */
export class WorkspaceEventStream {
	readonly origin = randomUUID();
	private readonly workspaces = new Map<string, WorkspaceRecord>();
	private readonly listeners = new Map<string, Set<WorkspaceEventListener>>();
	private readonly queue: Array<{ record: WorkspaceRecord; event: WorkspaceEvent; local: boolean }> = [];
	private dispatching = false;
	private seq = 0;
	constructor(private readonly options: { journal?: WorkspaceEventJournal; limit?: number; maxAgeMs?: number; now?: () => Date } = {}) {}

	private record(scope: WorkspaceEventScope): WorkspaceRecord {
		const key = workspaceEventKey(scope);
		let record = this.workspaces.get(key);
		if (!record) {
			record = { scope: { projectPath: path.resolve(scope.projectPath), projectId: scope.projectId, organizationId: scope.organizationId, userId: scope.userId },
				events: [], ui: { openFiles: [], recentChanges: [] }, sessions: new Map(), seen: new Set() };
			this.workspaces.set(key, record);
		}
		return record;
	}

	emit(scope: WorkspaceEventScope, source: WorkspaceSurface, input: WorkspaceEventInput | Record<string, unknown>, allowed?: ReadonlySet<WorkspaceEventType>): WorkspaceEvent {
		const record = this.record(scope);
		const parsed = parseWorkspaceEventInput(record.scope.projectPath, input, allowed);
		const scoped = SESSION_SCOPED_EVENTS.has(parsed.type);
		if (scoped && !validSession(scope.sessionId)) throw new Error("This workspace event belongs to a Chat session, and no session is bound.");
		const session = scoped ? { session: scope.sessionId! } : {};
		const event: WorkspaceEvent = { ...parsed, seq: ++this.seq, at: (this.options.now?.() ?? new Date()).toISOString(), workspace: workspaceEventKey(record.scope), source, origin: this.origin, ...session };
		this.enqueue(record, event, true);
		return event;
	}

	/** Pulls events written by other local processes (e.g. the GUI bridge) for this workspace. */
	async refresh(scope: WorkspaceEventScope): Promise<void> {
		const journal = this.options.journal;
		if (!journal) return;
		const record = this.record(scope);
		const key = workspaceEventKey(record.scope);
		const oldest = (this.options.now?.() ?? new Date()).getTime() - (this.options.maxAgeMs ?? 12 * 3_600_000);
		for (const line of await journal.read(key)) {
			const value = line as Partial<WorkspaceEvent>;
			const id = `${value.origin}:${value.seq}`;
			if (value.workspace !== key || value.origin === this.origin || typeof value.origin !== "string" || record.seen.has(id)) continue;
			record.seen.add(id);
			const at = typeof value.at === "string" ? Date.parse(value.at) : NaN;
			if (!Number.isFinite(at) || at < oldest) continue;
			let parsed;
			try { parsed = parseWorkspaceEventInput(record.scope.projectPath, value); } catch { continue; }
			const source = (["editor", "chat", "terminal", "flowchart", "learn", "question", "runtime"] as const).find(item => item === value.source) ?? "runtime";
			// Session-scoped events need a valid session and project events may not carry one: a missing,
			// malformed or forged session drops the event rather than widening it to every reader.
			const scoped = SESSION_SCOPED_EVENTS.has(parsed.type);
			if (scoped ? !validSession(value.session) : value.session !== undefined) continue;
			const session = scoped ? { session: value.session as string } : {};
			this.enqueue(record, { ...parsed, seq: ++this.seq, at: new Date(at).toISOString(), workspace: key, source, origin: value.origin, ...session }, false);
		}
		if (record.seen.size > 5_000) record.seen = new Set([...record.seen].slice(-2_500));
	}

	/** Receives project events and the events of `scope.sessionId`'s session. */
	subscribe(scope: WorkspaceEventScope, listener: WorkspaceEventListener): () => void {
		const key = workspaceEventKey(scope);
		const listeners = this.listeners.get(key) ?? new Set();
		const filtered: WorkspaceEventListener = event => { if (visibleToSession(event, scope.sessionId)) listener(event); };
		listeners.add(filtered);
		this.listeners.set(key, listeners);
		return () => { listeners.delete(filtered); };
	}

	/** Project events plus the events of `scope.sessionId`'s session, oldest first. */
	events(scope: WorkspaceEventScope): readonly WorkspaceEvent[] {
		return (this.workspaces.get(workspaceEventKey(scope))?.events ?? []).filter(event => visibleToSession(event, scope.sessionId));
	}

	/** Project UI state, with `learn` taken from `scope.sessionId`'s session. A session-less reader gets project state only. */
	ui(scope: WorkspaceEventScope): WorkspaceUiState {
		const record = this.workspaces.get(workspaceEventKey(scope));
		const ui = structuredClone(record?.ui ?? { openFiles: [], recentChanges: [] });
		const learn = this.session(scope).learn;
		return learn ? { ...ui, learn } : ui;
	}

	/** Transient state of `scope.sessionId`'s Chat session. Empty when no session is bound or it has published nothing. */
	session(scope: WorkspaceEventScope): WorkspaceSessionState {
		if (!validSession(scope.sessionId)) return {};
		return structuredClone(this.workspaces.get(workspaceEventKey(scope))?.sessions.get(scope.sessionId) ?? {});
	}

	/** Drops transient state for a workspace, e.g. when the session moves to another project. */
	forget(scope: WorkspaceEventScope): void {
		const key = workspaceEventKey(scope);
		this.workspaces.delete(key);
		for (let index = this.queue.length - 1; index >= 0; index--) if (this.queue[index]!.event.workspace === key) this.queue.splice(index, 1);
	}

	private enqueue(record: WorkspaceRecord, event: WorkspaceEvent, local: boolean): void {
		this.queue.push({ record, event, local });
		if (this.dispatching) return;
		this.dispatching = true;
		try {
			while (this.queue.length) {
				const next = this.queue.shift()!;
				if (this.workspaces.get(next.event.workspace) !== next.record) continue;
				const scoped = SESSION_SCOPED_EVENTS.has(next.event.type);
				if (scoped && !validSession(next.event.session)) continue;
				next.record.events = [...next.record.events, next.event].slice(-(this.options.limit ?? 200));
				let stale: string[] = [];
				if (scoped) {
					const id = next.event.session!;
					next.record.sessions.set(id, reduceSessionState(next.record.sessions.get(id) ?? {}, next.event));
				} else ({ ui: next.record.ui, stale } = reduceWorkspaceUi(next.record.ui, next.event));
				if (next.local) {
					next.record.seen.add(`${next.event.origin}:${next.event.seq}`);
					void this.options.journal?.append(next.event);
					if (stale.length) this.queue.push({ record: next.record, local: true, event: { type: "flowchart.stale", files: stale, seq: ++this.seq,
						at: next.event.at, workspace: next.event.workspace, source: "flowchart", origin: this.origin } });
				}
				for (const listener of [...(this.listeners.get(next.event.workspace) ?? [])]) {
					try { listener(next.event); } catch { /* A failing surface must not break other surfaces. */ }
				}
			}
		} finally { this.dispatching = false; }
	}
}
