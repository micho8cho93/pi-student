import type { LearningStage } from "@pi-student/contracts";

/** Canonical internal representation: lowercase, exactly these six values. */
export const LEARNING_STAGES = ["understand", "plan", "implement", "review", "verify", "reflect"] as const satisfies readonly LearningStage[];

/** Spellings smaller models emit for the same stages. Accepted only at the input boundary. */
const STAGE_COMPATIBILITY: Readonly<Record<string, LearningStage>> = {
	understanding: "understand",
	planning: "plan",
	implementation: "implement",
	implementing: "implement",
	reviewing: "review",
	verification: "verify",
	verifying: "verify",
	reflection: "reflect",
	reflecting: "reflect",
};

export function isLearningStage(value: unknown): value is LearningStage {
	return typeof value === "string" && (LEARNING_STAGES as readonly string[]).includes(value);
}

/**
 * Normalize a model/UI supplied stage to the canonical lowercase value.
 * Returns `undefined` for missing (`undefined`/`null`/blank) input and throws
 * for anything else that is not a known stage, so a bad value is never
 * silently replaced with the current stage.
 */
export function parseLearningStage(value: unknown): LearningStage | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new TypeError(`Unknown learning stage. Valid stages: ${LEARNING_STAGES.join(", ")}`);
	const normalized = value.trim().toLowerCase();
	if (!normalized) return undefined;
	if (isLearningStage(normalized)) return normalized;
	const alias = STAGE_COMPATIBILITY[normalized];
	if (alias) return alias;
	throw new TypeError(`Unknown learning stage "${value.slice(0, 40)}". Valid stages: ${LEARNING_STAGES.join(", ")}`);
}

/** Display-only rendering; never feed this back into runtime state. */
export function displayLearningStage(stage: LearningStage): string {
	return stage.toUpperCase();
}
