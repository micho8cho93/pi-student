import type { NextAvailableAction } from "./assistance.js";
import type { WorkspaceBudgetRow, WorkspaceBudgetState } from "./budget.js";
import type { LearningStage, ThinkingLevel } from "./policy.js";

/** Machine-readable cause of a restriction. UI surfaces map these to student-facing labels. */
export type CapabilityRestriction =
	| "project_not_selected"
	/** A managed (class) project whose student the trusted identity layer could not resolve. */
	| "identity_required"
	| "no_model"
	| "budget_exhausted"
	/** Agent execution budget is used up; tutoring may still be available. */
	| "agent_budget_exhausted"
	| "provider_unavailable"
	| "model_unavailable"
	| "authentication_failure"
	| "transient_failure"
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

/**
 * Authoritative identity of the workspace. Copied from ExecutionContext; never from UI input.
 *
 * Project identity (projectPath, projectId, organizationId, userId) keys project-scoped
 * state: files, tests, the map and project policy. sessionId additionally scopes
 * transient Chat state: Learn, prompts, model health, session budget and learning progress.
 */
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

/** Transient editor/UI state of a student project. Not persisted; cannot change scope or capabilities. */
export interface WorkspaceUiState {
	activeFile?: string;
	openFiles: string[];
	selectedCode?: { file: string; startLine?: number; endLine?: number };
	recentChanges: WorkspaceFileChange[];
	terminal?: { lastCommand?: string; lastExitCode?: number; actor?: "student" | "agent" };
	tests?: { lastRun?: WorkspaceTestResult };
	/** staleFiles: source files changed since the flowchart was generated. */
	flowchart?: { generatedAt?: string; selectedNode?: FlowchartNodeSelection; stale: boolean; staleFiles?: string[] };
	/**
	 * Learn Mode state of the Chat session this view follows, so Code, Map and
	 * Terminal use the same setting as that Chat. Scaffolding only; never a capability.
	 */
	learn?: { enabled: boolean; at: string };
}

/**
 * How much teaching scaffolding each surface adds. Derived only from Learn Mode.
 * It deliberately has no permission fields: Learn changes how help is given,
 * never what the student or the agent may do.
 */
export interface LearnScaffolding {
	enabled: boolean;
	chat: {
		explainReasoning: boolean;
		/** Offer a hint or next step before writing a full implementation. */
		hintsBeforeImplementation: boolean;
		connectToArchitecture: boolean;
		referenceStudentWork: boolean;
	};
	flowchart: {
		/** Which node text to favor. Both are generated together, so toggling never regenerates the map. */
		detail: "concise" | "educational";
		explainRelationships: boolean;
		/** A selected node becomes the focus of Chat's explanation. */
		selectionIsLearningContext: boolean;
	};
	editor: {
		/** Inline completion stays short in every mode. */
		autocomplete: "concise";
		/** How Chat treats code the student selected and asked about. */
		explainSelection: "direct" | "educational";
	};
	terminal: {
		/** Whether Chat explains a failed command or test before proposing a fix. */
		onFailure: "fix" | "explain-first";
		/** Learn never blocks or delays the student's own terminal. */
		blocksCommands: false;
	};
}

/** Bounded view of a session's WorkflowController state. Summaries only; never prompts or code. */
export interface WorkspaceLearningProgress {
	stage: LearningStage;
	goal?: string;
	activeStep?: string;
	understandingReady: boolean;
	planApproved: boolean;
	verificationPassed: boolean;
}

/** Metadata-only outcome of a trusted model request. No raw error details. */
export type WorkspaceModelHealth = { status: "available" | "provider_unavailable" | "model_unavailable" | "authentication_failure" | "transient_failure" };

/**
 * Transient state of one Chat session, reduced from its session-scoped events.
 * It is a publication of the session's execution authorities (WorkflowController,
 * CapabilityState, observed model responses), never a second store of them.
 */
export interface WorkspaceSessionState {
	learn?: { enabled: boolean; at: string };
	model?: { selected?: string; health?: WorkspaceModelHealth; available?: boolean; toolUse?: boolean; at: string };
	/** lane "agent": only AI implementation stopped; "all": every AI surface stopped. */
	budget?: { exhausted?: { reason: string; lane: "agent" | "all"; at: string }; warning?: { reason: string; at: string } };
	progress?: WorkspaceLearningProgress & { at: string };
	lastPromptAt?: string;
}

/** A persisted map as the workspace sees it. Viewing it never needs AI. */
export interface WorkspaceMapStatus {
	available: boolean;
	generatedAt?: string;
	/** Source files changed, removed or added since generation, computed from the files on disk. */
	stale: boolean;
	staleFiles: string[];
	selectedNode?: FlowchartNodeSelection;
	filesRead?: number;
	model?: string;
}

/**
 * The one current answer to "what is the state of this student's workspace?".
 * Derived on request from ExecutionContext, effective policy, model admission and
 * health, the session's workflow state, the workspace events and the persisted map.
 * Surfaces render it; none of them owns a copy. Metadata only: no host paths,
 * file contents, prompts, command output or credentials.
 */
export interface StudentWorkspaceSnapshot {
	/** Content hash; equal revisions mean nothing a surface shows has changed. */
	revision: string;
	/**
	 * identityRequired: a managed project whose signed-in student could not be resolved. The
	 * snapshot then carries no workspace, session or map state, only what still works manually.
	 */
	scope: { managed: boolean; projectId?: string; classId?: string; organizationId?: string; session: boolean; identityRequired?: true };
	learning: WorkspaceLearningProgress & {
		/** live: published by the running Chat session; saved: its last persisted snapshot; default: no session state yet. */
		source: "live" | "saved" | "default";
	};
	learn: LearnScaffolding;
	capabilities: EffectiveStudentCapabilities;
	budget: WorkspaceBudgetRow[];
	model: { available: boolean; health?: WorkspaceModelHealth; reason?: CapabilityRestriction; selected?: string };
	actions: NextAvailableAction[];
	fallback?: { headline: string; canStill: string[]; hint?: string };
	map: WorkspaceMapStatus;
	activity: {
		activeFile?: string;
		recentChanges: WorkspaceFileChange[];
		/** Outcome of the latest test run, without output excerpts. */
		lastTest?: Omit<WorkspaceTestResult, "summary">;
	};
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
