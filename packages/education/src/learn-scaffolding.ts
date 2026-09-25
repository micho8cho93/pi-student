import type { LearnScaffolding } from "@pi-student/contracts";

/**
 * The one answer to "how much should each surface teach right now?". Every
 * surface (Chat, Code, Map, Terminal) reads the same profile, so switching
 * between them never changes Learn behavior. It is a pure function of Learn
 * Mode and carries no capability: tools, commands, budgets and sandbox policy
 * are resolved elsewhere and are identical with Learn on or off.
 */
export function resolveLearnScaffolding(learnMode: boolean): LearnScaffolding {
	const enabled = learnMode === true;
	return {
		enabled,
		chat: { explainReasoning: enabled, hintsBeforeImplementation: enabled, connectToArchitecture: enabled, referenceStudentWork: enabled },
		flowchart: { detail: enabled ? "educational" : "concise", explainRelationships: enabled, selectionIsLearningContext: enabled },
		editor: { autocomplete: "concise", explainSelection: enabled ? "educational" : "direct" },
		terminal: { onFailure: enabled ? "explain-first" : "fix", blocksCommands: false },
	};
}
