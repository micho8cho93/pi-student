import type { CapabilityPolicy, LearningStage, ThinkingLevel } from "./policy.js";

/** Whether a student-facing surface may be used right now, and why not. */
export interface CapabilityAvailability {
	allowed: boolean;
	/** Student-readable explanation when not allowed. */
	reason?: string;
}

export interface WorkspaceBudgetState {
	limits: CapabilityPolicy["limits"];
	/** null = unlimited. */
	remaining: { minutes: number | null; turns: number | null; tokens: number | null; cost: number | null };
	/** Set when a limit has been reached or project controls are unavailable. */
	exhausted?: string;
}

/**
 * The one resolved answer to "what can this student do right now?".
 * Derived from ExecutionContext + policy; never a source of policy itself.
 */
export interface EffectiveStudentCapabilities {
	projectId?: string;
	organizationId?: string;
	chat: CapabilityAvailability;
	agentFileEditing: CapabilityAvailability;
	autocomplete: CapabilityAvailability;
	/** inspectionOnly: shell limited to read-only commands (file editing or dependency installation disabled). */
	terminal: CapabilityAvailability & { inspectionOnly: boolean };
	internet: CapabilityAvailability;
	dependencyInstallation: CapabilityAvailability;
	/** Names of school skills and MCP connectors authorized for listing at the current stage. */
	extensions: CapabilityAvailability & { skills: string[]; mcps: string[] };
	learn: CapabilityAvailability;
	/** provider/model IDs the student may select. */
	models: string[];
	reasoningLevels: ThinkingLevel[];
	budget: WorkspaceBudgetState;
}

/** Authoritative identity of the workspace. Copied from ExecutionContext; never from UI input. */
export interface WorkspaceScope {
	readonly projectPath: string;
	readonly userId?: string;
	readonly projectId?: string;
	readonly classId?: string;
	readonly organizationId?: string;
	readonly sessionId?: string;
}

export interface WorkspaceFileChange {
	file: string;
	kind: "created" | "modified" | "deleted";
	/** Who made the change: the student in the editor, or the agent through its tools. */
	author: "student" | "agent";
	at: string;
}

export interface WorkspaceTestResult {
	command: string;
	passed: boolean;
	exitCode?: number;
	/** Short redacted excerpt of failing lines; never the full output. */
	summary?: string;
	at: string;
}

/** Transient editor/UI state. Not persisted; cannot change scope or capabilities. */
export interface WorkspaceUiState {
	activeFile?: string;
	openFiles: string[];
	selectedCode?: { file: string; startLine?: number; endLine?: number };
	recentChanges: WorkspaceFileChange[];
	terminal?: { lastCommand?: string; lastExitCode?: number };
	tests?: { lastRun?: WorkspaceTestResult };
	/** staleFiles: source files changed since the flowchart was generated. */
	flowchart?: { generatedAt?: string; selectedNodeId?: string; stale: boolean; staleFiles?: string[] };
}

/** What the student is currently doing in this project. */
export interface StudentWorkspaceContext {
	/** Security state (from ExecutionContext). */
	readonly scope: WorkspaceScope;
	readonly capabilities: EffectiveStudentCapabilities;
	/** Durable learning state (owned by the education workflow). */
	readonly learning: { stage: LearningStage; learnMode: boolean };
	readonly model?: string;
	/** Transient UI state. */
	readonly ui: Readonly<WorkspaceUiState>;
}
