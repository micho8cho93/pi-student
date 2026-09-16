import type { EngineeringConcern } from "./engineering-concern.js";
import {
	type QuestionContext,
	type QuestionDecision,
	type StudentAnswer,
	type StudentQuestion,
} from "./question-context.js";
import type { LearningStage } from "./types.js";
import type { LearningIntent } from "./intent.js";
import { projectContextFacts } from "./project-context.js";

export interface QuestionAssessment {
	sufficientInformation: boolean;
	unresolvedIssues: string[];
	discoveredDecisions: string[];
	concerns: EngineeringConcern[];
	recommendedNextStage?: LearningStage;
}

export interface StudentQuestionLoopContract {
	evaluate(context: QuestionContext): Promise<QuestionDecision>;
	buildQuestions(context: QuestionContext): Promise<StudentQuestion[]>;
	processAnswers(questions: StudentQuestion[], answers: StudentAnswer[]): Promise<QuestionAssessment>;
}

const QUESTIONS_BY_STAGE: Record<LearningStage, readonly Omit<StudentQuestion, "id">[]> = {
	understand: [
		{ prompt: "What behavior should the finished change provide?", category: "requirements", required: true },
		{ prompt: "What constraints or existing behavior must we preserve?", category: "requirements", required: true },
		{ prompt: "Which implementation approach should we use?", category: "architecture", options: ["Use the existing project structure", "Introduce a small new module", "Let Pi choose based on the repository"], allowCustom: true },
		{ prompt: "What engineering decision would you like to understand while we build this?", category: "reflection" },
	],
	plan: [
		{ prompt: "Where should the main responsibility for this change live?", category: "architecture", required: true },
		{ prompt: "What information flows between the components involved?", category: "architecture", required: true },
		{ prompt: "How will you test the change and its important failure cases?", category: "testing", options: ["Unit tests", "Integration or end-to-end tests", "Manual verification", "A combination"], allowCustom: true },
		{ prompt: "In what order should the implementation steps happen?", category: "tradeoffs" },
	],
	implement: [
		{ prompt: "What assumption are you making before this implementation step?", category: "implementation", required: true },
		{ prompt: "Where should this responsibility belong, and why?", category: "architecture" },
		{ prompt: "What happens if the input or dependency is missing?", category: "debugging" },
		{ prompt: "What scope change would require us to pause and revisit the plan?", category: "tradeoffs" },
	],
	review: [
		{ prompt: "Which changed file implements the main feature?", category: "review", required: true },
		{ prompt: "Did anything change that you did not expect?", category: "review", required: true },
		{ prompt: "Does the diff still match the student-authored plan?", category: "architecture" },
		{ prompt: "What coupling or readability concern do you notice in the changes?", category: "architecture" },
	],
	verify: [
		{ prompt: "How should we prove this works?", category: "testing", options: ["Run the project's automated tests", "Build or type-check the project", "Exercise the behavior manually", "A combination"], allowCustom: true, required: true },
		{ prompt: "What output or result do you expect before we run verification?", category: "prediction", required: true },
		{ prompt: "What edge case might break this implementation?", category: "testing" },
		{ prompt: "If verification fails, what kind of cause would you investigate first?", category: "debugging" },
	],
	reflect: [
		{ prompt: "Why does this design work for the requirements?", category: "reflection", required: true },
		{ prompt: "What did you learn from the implementation or verification?", category: "reflection", required: true },
		{ prompt: "What would you improve if you had another iteration?", category: "reflection" },
	],
};

export class StudentQuestionLoop implements StudentQuestionLoopContract {
	async evaluate(context: QuestionContext): Promise<QuestionDecision> {
		if (!context.studentMessage?.trim() && !context.previousQuestions?.length) {
			return { shouldAsk: false, maxQuestions: 0, reason: "There is no substantive student message to explore." };
		}
		if (context.informationSufficient) {
			return { shouldAsk: false, maxQuestions: 0, reason: "The student has supplied enough information for this stage." };
		}
		const round = context.questionRound ?? 0;
		const maxRounds = context.maxRounds ?? 3;
		if (round >= maxRounds) {
			return { shouldAsk: false, maxQuestions: 0, reason: "The question loop reached its maximum rounds; continue with the available information." };
		}
		return {
			shouldAsk: true,
			maxQuestions: context.intent ? 4 : questionBudget(context.studentMessage, round),
			reason: round === 0 ? "A substantive request needs an initial reasoning round." : "Important information remains unresolved after the previous answers.",
		};
	}

	async buildQuestions(context: QuestionContext): Promise<StudentQuestion[]> {
		const decision = await this.evaluate(context);
		if (!decision.shouldAsk) return [];
		const asked = new Set((context.previousQuestions ?? []).map((question) => question.prompt));
		const knownFacts = [
			...(context.knownFacts ?? []),
			...(context.projectContext ? projectContextFacts(context.projectContext) : []),
		].map((fact) => fact.toLowerCase());
		const templates = context.intent
			? questionsForIntent(context.intent, context)
			: context.intentAmbiguous
				? [INTENT_CLARIFICATION, ...QUESTIONS_BY_STAGE[context.stage]]
				: QUESTIONS_BY_STAGE[context.stage];
		return templates
			.filter((question) => !asked.has(question.prompt))
			.filter((question) => !isAnsweredByContext(question.prompt, context, knownFacts))
			.slice(0, decision.maxQuestions)
			.map((question, index) => ({ ...question, id: `${context.stage}-q${(context.questionRound ?? 0) + 1}-${index + 1}` }));
	}

	async processAnswers(questions: StudentQuestion[], answers: StudentAnswer[]): Promise<QuestionAssessment> {
		const answerById = new Map(answers.map((answer) => [answer.questionId, answer.answer.trim()]));
		const unresolvedIssues: string[] = [];
		const discoveredDecisions: string[] = [];
		for (const question of questions) {
			const answer = answerById.get(question.id) ?? "";
			if (question.required !== false && !answer) unresolvedIssues.push(question.prompt);
			if (answer) discoveredDecisions.push(`${question.prompt} — ${answer}`);
		}

		return {
			sufficientInformation: unresolvedIssues.length === 0 && questions.length > 0,
			unresolvedIssues,
			discoveredDecisions,
			concerns: [],
		};
	}
}

function questionBudget(message: string | undefined, round: number): number {
	if (round > 0) return 2;
	const text = message?.trim() ?? "";
	if (/\b(hello[, ]*world|display|print|touch|mkdir|create (a |an )?(file|folder|directory))\b/i.test(text) && text.length < 180) return 1;
	if (text.length < 260) return 2;
	if (text.length < 700) return 3;
	return 4;
}

const QUESTIONS_BY_INTENT: Record<LearningIntent, readonly Omit<StudentQuestion, "id">[]> = {
	BUILD: [
		{ prompt: "What should the finished project or feature let someone do?", category: "requirements", required: true },
		{ prompt: "Which features matter most for the first working version?", category: "requirements", required: true },
		{ prompt: "I found the project stack from the workspace. Do you want to continue with it, or change the technology for this feature?", category: "architecture", options: ["Continue with the detected stack", "Change the stack for this feature"], allowCustom: true, required: true },
		{ prompt: "Where and how should this run when it is ready?", category: "deployment", options: ["Locally for now", "As a web app", "As a command-line program", "Another runtime"], allowCustom: true },
	],
	TUTOR: [
		{ prompt: "What are you trying to accomplish, and what should the result do?", category: "requirements", required: true },
		{ prompt: "Which part do you already understand, and where does it become confusing?", category: "reflection", required: true },
		{ prompt: "What have you tried so far, including any code or result you saw?", category: "implementation", required: true },
		{ prompt: "How would you like to work together?", category: "reflection", options: ["Hints and questions", "Pseudocode and a guided plan", "Implement it together after we reason it out"], required: true },
	],
	EXPLAIN: [
		{ prompt: "What part of this concept feels confusing or worth focusing on?", category: "requirements", required: true },
		{ prompt: "What do you already know about it?", category: "reflection", required: true },
		{ prompt: "Which language or project context should I use for the example?", category: "implementation", required: true },
		{ prompt: "Which explanation style would help most?", category: "reflection", options: ["Code example", "Analogy", "Diagram-like steps", "A combination"], required: true },
	],
	DEBUG: [
		{ prompt: "What should the program do when it works?", category: "debugging", required: true },
		{ prompt: "What does it actually do instead?", category: "debugging", required: true },
		{ prompt: "What error message, output, log, or failing test can we inspect?", category: "debugging", required: true },
		{ prompt: "What have you already tried, and what changed after each attempt?", category: "debugging", required: true },
	],
	CHECK: [
		{ prompt: "Which files, feature, or section should I review?", category: "review", required: true },
		{ prompt: "What requirements or intended behavior should the code satisfy?", category: "requirements", required: true },
		{ prompt: "What kind of feedback do you want?", category: "review", options: ["Correctness and bugs", "Readability and structure", "Architecture and maintainability", "All of these"], required: true },
		{ prompt: "Is there a particular concern or edge case you want me to investigate?", category: "review" },
	],
};

const INTENT_CLARIFICATION: Omit<StudentQuestion, "id"> = {
	prompt: "What kind of help would be most useful right now?",
	category: "requirements",
	options: ["Build it with me", "Guide me while I solve it", "Explain the concept", "Debug broken behavior", "Check my existing code"],
	required: true,
};

function questionsForIntent(intent: LearningIntent, context: QuestionContext): readonly Omit<StudentQuestion, "id">[] {
	const questions = QUESTIONS_BY_INTENT[intent];
	if ((intent === "BUILD" || intent === "EXPLAIN") && context.projectContext && (context.projectContext.languages.length || context.projectContext.frameworks.length)) {
		const stack = [...context.projectContext.languages, ...context.projectContext.frameworks].join(", ");
		return questions.map((question) => question.prompt.startsWith("I found")
			? { ...question, prompt: `I found ${stack} in the workspace. Do you want to continue with that stack for this feature?` }
			: intent === "EXPLAIN" && question.prompt.startsWith("Which language or project context")
				? { ...question, prompt: `I found ${stack} in the workspace. Should I use that context for the example, or another one?`, options: ["Use the detected project context", "Use another context"], allowCustom: true }
			: question);
	}
	return questions;
}

function isAnsweredByContext(prompt: string, context: QuestionContext, knownFacts: string[]): boolean {
	const text = prompt.toLowerCase();
	if (text.includes("language or project context") && context.projectContext?.languages.length) return true;
	if (text.includes("stack") && context.projectContext && (context.projectContext.languages.length || context.projectContext.frameworks.length)) return false;
	if (text.includes("test") && context.projectContext?.testFramework && context.intent !== "DEBUG") return true;
	if (text.includes("git") && context.projectContext?.hasGit) return true;
	return knownFacts.some((fact) => fact && text.includes(fact));
}
