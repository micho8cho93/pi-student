import type { LearningStage } from "./types.js";
import type { LearningIntent } from "./intent.js";
import type { ProjectContext } from "./project-context.js";

export const QUESTION_CATEGORIES = [
	"requirements",
	"architecture",
	"implementation",
	"security",
	"testing",
	"deployment",
	"debugging",
	"tradeoffs",
	"prediction",
	"reflection",
	"terminal",
	"review",
] as const;

export type QuestionCategory = (typeof QUESTION_CATEGORIES)[number];

export function isQuestionCategory(value: unknown): value is QuestionCategory {
	return typeof value === "string" && QUESTION_CATEGORIES.includes(value as QuestionCategory);
}

/**
 * `required` contract (single source of truth for Terminal, Paseo and the loop):
 *  - `required: true`  -> a non-blank answer is needed before the round can complete.
 *  - `required: false` -> optional; a blank answer is accepted.
 *  - `required` omitted -> optional, identical to `false`.
 * Only a real boolean is meaningful. Use `isQuestionRequired`; never test `question.required` for truthiness.
 */
export interface StudentQuestion {
	id: string;
	prompt: string;
	category: QuestionCategory;
	label?: string;
	note?: string;
	options?: string[];
	allowCustom?: boolean;
	required?: boolean;
}

export function isQuestionRequired(question: Pick<StudentQuestion, "required">): boolean {
	return question.required === true;
}

/**
 * Model/input boundary for the `required` flag. Returns `undefined` when the
 * flag is omitted, tolerates the exact strings "true"/"false" that smaller
 * models emit, and throws for anything else instead of guessing.
 */
export function parseQuestionRequired(value: unknown): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "true") return true;
		if (normalized === "false") return false;
	}
	throw new TypeError("required must be a boolean (true or false) or omitted");
}

export interface StudentAnswer {
	questionId: string;
	answer: string;
}

export interface QuestionContext {
	stage: LearningStage;
	intent?: LearningIntent;
	intentAmbiguous?: boolean;
	projectContext?: ProjectContext;
	studentMessage?: string;
	questionRound?: number;
	previousQuestions?: StudentQuestion[];
	previousAnswers?: StudentAnswer[];
	knownDecisions?: string[];
	knownFacts?: string[];
	informationSufficient?: boolean;
	maxRounds?: number;
}

export interface QuestionDecision {
	shouldAsk: boolean;
	maxQuestions: number;
	reason: string;
}
