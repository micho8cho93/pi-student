export type Responsibility = "agent" | "together" | "student";

export type LearningAction =
	| "create-file"
	| "edit-code"
	| "run-tests"
	| "inspect-workspace"
	| "install-dependency"
	| "format-code"
	| "design-architecture"
	| "debug-logic"
	| "choose-design"
	| "explain-reasoning"
	| "git-commit"
	| "git-stage"
	| "git-push"
	| "git-pull"
	| "git-fetch"
	| "merge-branches"
	| "resolve-merge-conflict"
	| "navigate-directory"
	| "terminal-learning";

export interface ActionProposal {
	action: LearningAction;
	/** Override the default when a particular exercise explicitly makes this learning-critical. */
	learningCritical?: boolean;
}

export interface ResponsibilityDecision {
	responsibility: Responsibility;
	reason: string;
}

const DEFAULT_RESPONSIBILITIES: Record<LearningAction, Responsibility> = {
	"create-file": "agent",
	"edit-code": "agent",
	"run-tests": "agent",
	"inspect-workspace": "agent",
	"install-dependency": "agent",
	"format-code": "agent",
	"design-architecture": "together",
	"debug-logic": "together",
	"choose-design": "together",
	"explain-reasoning": "student",
	"git-commit": "student",
	"git-stage": "student",
	"git-push": "student",
	"git-pull": "student",
	"git-fetch": "student",
	"merge-branches": "student",
	"resolve-merge-conflict": "student",
	"navigate-directory": "student",
	"terminal-learning": "student",
};

/** Centralized, intentionally small policy for preserving student agency. */
export function classifyResponsibility(proposal: ActionProposal): ResponsibilityDecision {
	if (proposal.learningCritical) {
		return { responsibility: "together", reason: "This action is marked as learning-critical for the current task." };
	}
	const responsibility = DEFAULT_RESPONSIBILITIES[proposal.action];
	const reason = responsibility === "agent"
		? "Routine implementation or verification work can be handled by the agent."
		: responsibility === "together"
			? "The student should understand and participate in the important reasoning."
			: "The student keeps control of this repository operation or explanation. ";
	return { responsibility, reason: reason.trim() };
}

export interface LearningBoundary {
	classify(proposal: ActionProposal): ResponsibilityDecision;
}

export class ConfigurableLearningBoundary implements LearningBoundary {
	constructor(private readonly overrides: Partial<Record<LearningAction, Responsibility>> = {}) {}

	classify(proposal: ActionProposal): ResponsibilityDecision {
		if (proposal.learningCritical) return classifyResponsibility(proposal);
		const responsibility = this.overrides[proposal.action] ?? DEFAULT_RESPONSIBILITIES[proposal.action];
		return {
			responsibility,
			reason: `Configured responsibility: ${responsibility.toUpperCase()}.`,
		};
	}
}

export function responsibilityForTerminalCommand(command: string): ResponsibilityDecision | undefined {
	const text = command.trim().toLowerCase();
	if (/^git\s+commit\b/.test(text)) return classifyResponsibility({ action: "git-commit" });
	if (/^git\s+add\b/.test(text)) return classifyResponsibility({ action: "git-stage" });
	if (/^git\s+(push|pull|fetch)\b/.test(text)) return classifyResponsibility({ action: text.startsWith("git pull") ? "git-pull" : text.startsWith("git fetch") ? "git-fetch" : "git-push" });
	if (/^git\s+(merge|rebase|cherry-pick|branch|switch|checkout)\b/.test(text)) return classifyResponsibility({ action: "merge-branches" });
	if (/\b(cd|pushd|popd)\b/.test(text)) return classifyResponsibility({ action: "navigate-directory" });
	return undefined;
}
