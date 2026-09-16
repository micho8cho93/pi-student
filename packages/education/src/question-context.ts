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
