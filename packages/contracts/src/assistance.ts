import type { CapabilityRestriction } from "./workspace.js";

/**
 * Steps of the assistance ladder, from most to least AI-dependent. Losing a
 * higher step never removes a lower one that its own requirements still permit.
 *
 *   agent execution → guided AI assistance → autocomplete → manual editing
 *   → terminal / testing → AI explanation / tutoring
 */
export type StudentAction =
	/** The agent edits files for the student. */
	| "agent-edit"
	/** The agent runs commands or tests in its sandbox. */
	| "agent-run-command"
	/** The agent installs project dependencies. */
	| "agent-install-dependencies"
	/** Ask the AI for hints, plans, and next steps without it editing code. */
	| "ask-guidance"
	/** Ask the AI to explain code, errors, or concepts. */
	| "ask-explanation"
	/** Learn mode: guided questions about the project. */
	| "learn-mode"
	/** Longer AI reasoning for hard problems. */
	| "deep-reasoning"
	| "autocomplete"
	/** Open and edit files manually. */
	| "open-editor"
	/** Run commands and tests in the student's own terminal. */
	| "use-terminal"
	| "run-tests"
	/** View the flowchart that was already generated. */
	| "view-map"
	/** Generate or refresh the flowchart (uses the AI model). */
	| "generate-map"
	| "use-school-tools"
	| "use-internet";

/** One deterministic recommendation. Surfaces translate `action` and `reason` into student-facing text. */
export interface NextAvailableAction {
	action: StudentAction;
	available: boolean;
	/** Set when unavailable. */
	reason?: CapabilityRestriction;
	/** Set when available and the action is a suggested fallback for a lost higher step. */
	recommended?: true;
}
