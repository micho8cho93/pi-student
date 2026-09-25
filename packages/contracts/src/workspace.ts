import type { WorkspaceBudgetState } from "./budget.js";
import type { LearningStage, ThinkingLevel } from "./policy.js";

/** Machine-readable cause of a restriction. UI surfaces map these to student-facing labels. */
export type CapabilityRestriction =
	| "project_not_selected"
	| "no_model"
	| "budget_exhausted"
	/** Agent execution budget is used up; tutoring may still be available. */
	| "agent_budget_exhausted"
	| "provider_unavailable"
	| "model_cannot_use_tools"
	| "agent_editing_disabled"
	| "autocomplete_disabled"
	| "terminal_disabled"
	| "dependency_installation_disabled"
	| "internet_disabled"
	| "sandbox_unavailable"
	| "reasoning_restricted"
	| "no_extensions"
	| "no_flowchart";

/** Whether a student-facing surface may be used right now, and why not. */
export interface CapabilityAvailability {
	allowed: boolean;
	/** Student-readable explanation when not allowed. */
	reason?: string;
	/** Machine-readable cause when not allowed. */
	code?: CapabilityRestriction;
}

/**
 * The one resolved answer to "what can this student do right now?".
 * Derived from ExecutionContext + policy; never a source of policy itself.
 */
export interface EffectiveStudentCapabilities {
	projectId?: string;
	organizationId?: string;
	chat: CapabilityAvailability;
	/** Whether the active model can reliably drive tools (file edits, commands). Conversation may still work without it. */
	toolUse: CapabilityAvailability;
	/** Whether the agent's isolated execution environment is running. The student's own editor and terminal do not depend on it. */
	sandbox: CapabilityAvailability;
	agentFileEditing: CapabilityAvailability;
	autocomplete: CapabilityAvailability;
	/** Generating the project flowchart with AI. Viewing an existing map never needs AI. */
	architecture: CapabilityAvailability;
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
	/**
	 * Who made the change: the student typing in the editor, the student accepting
	 * an AI autocomplete suggestion, or the agent through its tools.
	 */
	author: "student" | "autocomplete" | "agent";
	at: string;
}

export interface WorkspaceTestResult {
	command: string;
	passed: boolean;
	exitCode?: number;
	/** Short redacted excerpt of failing lines; never the full output. */
	summary?: string;
	/** Failing test files or names, when they could be detected. */
	failedTests?: string[];
	/** Who ran the tests. */
	actor?: "student" | "agent";
	at: string;
}

/** A flowchart node's optional link to source. Paths are project-relative and validated. */
export interface FlowchartSourceRef {
	file?: string;
	symbol?: string;
	line?: number;
	relatedFiles?: string[];
}

export interface FlowchartNodeSelection extends FlowchartSourceRef {
	id: string;
	label: string;
}

/** Transient editor/UI state. Not persisted; cannot change scope or capabilities. */
export interface WorkspaceUiState {
	activeFile?: string;
	openFiles: string[];
	selectedCode?: { file: string; startLine?: number; endLine?: number };
	recentChanges: WorkspaceFileChange[];
	terminal?: { lastCommand?: string; lastExitCode?: number; actor?: "student" | "agent" };
	tests?: { lastRun?: WorkspaceTestResult };
	/** staleFiles: source files changed since the flowchart was generated. */
	flowchart?: { generatedAt?: string; selectedNode?: FlowchartNodeSelection; stale: boolean; staleFiles?: string[] };
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
