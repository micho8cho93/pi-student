import type { CapabilityPolicy, ThinkingLevel } from "./policy.js";

/**
 * What an AI request is for. Accounting is shared (one ledger, one set of
 * session counters); purpose only decides which lane a request draws on.
 *
 * - agent: the AI edits files or runs commands (tool-using requests).
 * - tutoring: guidance, explanations, Learn mode (tool-free chat).
 * - autocomplete: editor suggestions.
 * - architecture: generating the project flowchart.
 */
export type BudgetPurpose = "agent" | "tutoring" | "autocomplete" | "architecture";

/** low: a warning threshold was crossed. unavailable: the budget could not be checked. */
export type BudgetLaneStatus = "available" | "low" | "exhausted" | "unavailable";

export interface BudgetLane {
	status: BudgetLaneStatus;
	/** Student-readable explanation when not available. */
	reason?: string;
}

/**
 * The one workspace-facing budget view. It is derived from the existing
 * accounting (session counters, organization monthly budgets via model
 * admission) and never stores usage of its own.
 *
 * Lanes are ordered so AI doing stops before AI assisting:
 *   agent → tutoring / architecture / autocomplete → overall.
 * Manual tools are not a lane; they never depend on AI budget.
 */
export interface WorkspaceBudgetState {
	/** All AI stops when this is exhausted. */
	overall: BudgetLane;
	agent: BudgetLane;
	tutoring: BudgetLane;
	autocomplete: BudgetLane;
	architecture: BudgetLane;
	/**
	 * Low-level session quotas for teachers and diagnostics. Student surfaces
	 * show lane status only.
	 */
	session: {
		limits: CapabilityPolicy["limits"];
		/** null = unlimited. tutoringTurns counts only after the agent limit is reached. */
		remaining: { minutes: number | null; turns: number | null; tokens: number | null; cost: number | null; tutoringTurns: number | null };
	};
}

/** Result of host-side request admission for one purpose. */
export interface ModelAdmissionDecision {
	warning: boolean;
	/** The requested purpose may not use the model. */
	blocked: boolean;
	/** Agent execution is blocked; set even when the requested purpose is still admitted from a tutoring reserve. */
	agentBlocked?: boolean;
	action?: "block_model" | "fallback" | "block_ai" | "assistance_only";
}

/** Host hook run before a direct model request; throws when the purpose is not admitted. */
export type ModelAdmissionGate = (provider: string, modelId: string, thinking: ThinkingLevel, purpose: BudgetPurpose) => Promise<void>;
