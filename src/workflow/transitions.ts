import type { LearningStage } from "./types.js";

const LEGAL_TRANSITIONS: Record<LearningStage, readonly LearningStage[]> = {
	understand: ["plan"],
	plan: ["implement"],
	implement: ["review", "plan"],
	review: ["implement", "plan", "verify"],
	verify: ["implement", "reflect"],
	reflect: [],
};

export function canTransition(from: LearningStage, to: LearningStage): boolean {
	return LEGAL_TRANSITIONS[from].includes(to);
}

export function transitionsFrom(stage: LearningStage): readonly LearningStage[] {
	return LEGAL_TRANSITIONS[stage];
}
