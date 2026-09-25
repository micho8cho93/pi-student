import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { StudentQuestionLoop } from "@pi-student/education/student-question-loop";
import {
	isQuestionCategory,
	isQuestionRequired,
	parseQuestionRequired,
	QUESTION_CATEGORIES,
	type QuestionCategory,
	type QuestionContext,
	type StudentAnswer,
	type StudentQuestion,
} from "@pi-student/education/question-context";
import { StudentAskParams } from "./tool-parameter-schemas.js";
import { prepareStudentAskArguments } from "./tool-arguments.js";
import { toolResult as result } from "./tool-result.js";

export function createStudentAskExtension(
	loop = new StudentQuestionLoop(),
	getContext: () => QuestionContext = () => ({ stage: "understand" }),
	prepareContext?: (studentMessage: string) => Promise<Partial<QuestionContext>>,
	isPracticingQuestion: () => boolean = () => false,
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		let context = getContext();
		pi.on("before_agent_start", async (event) => {
			if (isPracticingQuestion()) return;
			const prepared = prepareContext ? await prepareContext(event.prompt) : {};
			const nextContext = { ...getContext(), ...prepared };
			const continuingStage = context.stage === nextContext.stage && context.intent === nextContext.intent;
			context = {
				...nextContext,
				studentMessage: event.prompt,
				questionRound: continuingStage ? context.questionRound : 0,
				previousQuestions: continuingStage ? context.previousQuestions : [],
				previousAnswers: continuingStage ? context.previousAnswers : [],
				knownDecisions: continuingStage ? context.knownDecisions : [],
				informationSufficient: continuingStage ? context.informationSufficient : false,
			};
		});
		pi.registerTool({
			name: "student_ask",
			label: "Student questions",
			description: `Ask the student one to four structured questions. Categories must be one of: ${QUESTION_CATEGORIES.join(", ")}. Never invent category names.`,
			promptSnippet: "Ask the student targeted engineering questions.",
	promptGuidelines: [
				"Use for substantive decisions, not trivial confirmations.",
				"Ask no more than four questions in one round and build later rounds on the answers.",
				"Do not ask for facts that can be learned by inspecting the repository.",
				"When a decision has a small set of meaningful choices, provide options so the student can select with the keyboard.",
				"Questions must affect the current implementation, engineering reasoning, or student's understanding; do not invent speculative future-work questions to satisfy a quota.",
			],
			parameters: StudentAskParams,
			prepareArguments: prepareStudentAskArguments,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const round = context.questionRound ?? 0;
				const maxRounds = context.maxRounds ?? 3;
				if (round >= maxRounds) {
					return result(
						"No further student questions are needed; continue with the available information.",
						{ questions: [], answers: [], assessment: { sufficientInformation: false }, stopped: true, reason: "max_rounds_reached", nextAction: "Continue with the current stage." },
					);
				}
				const questions = params.questions
					? normalizeQuestions(params.questions)
					: await loop.buildQuestions(context);
				if (!params.questions && questions.length === 0) {
					return result(
						"No new student questions are available; continue with the available information.",
						{ questions: [], answers: [], assessment: { sufficientInformation: context.informationSufficient ?? false }, stopped: true, reason: "no_new_questions", nextAction: "Continue with the current stage." },
					);
				}
				const duplicatePrompts = questions.filter((question, index, all) => all.findIndex((candidate) => candidate.prompt === question.prompt) !== index);
				const previousPrompts = new Set((context.previousQuestions ?? []).map((question) => question.prompt));
				if (duplicatePrompts.length > 0 || questions.some((question) => previousPrompts.has(question.prompt))) {
					return result(
						"These questions were already asked. Continue with the current stage or ask only new questions.",
						{ questions, code: "DUPLICATE_QUESTIONS", stopped: true, recoverable: true, nextAction: "Continue with the current stage or ask only new questions." },
					);
				}
				if (questions.length < 1 || questions.length > 4) {
					return result("student_ask requires between one and four questions.", { questions, code: "INVALID_QUESTION_COUNT", nextAction: "Retry once with one to four new questions." }, true);
				}

				const answers: StudentAnswer[] = [];
				for (const [index, question] of questions.entries()) {
					const title = `${question.label ?? categoryLabel(question.category)} · ${index + 1}/${questions.length}`;
					const answer = await askQuestion(ctx, question, title);
					if (answer === undefined) {
						return result("The student cancelled this question round.", { questions, answers, cancelled: true, stopped: true, recoverable: true, nextAction: "Continue only if the available information is sufficient; otherwise ask later." });
					}
					answers.push({ questionId: question.id, answer });
				}

				const assessment = await loop.processAnswers(questions, answers);
				context = {
					...context,
					questionRound: (context.questionRound ?? 0) + 1,
					previousQuestions: [...(context.previousQuestions ?? []), ...questions],
					previousAnswers: [...(context.previousAnswers ?? []), ...answers],
					knownDecisions: [...(context.knownDecisions ?? []), ...assessment.discoveredDecisions],
					informationSufficient: assessment.sufficientInformation,
				};
				return result(
					JSON.stringify({ answers, assessment }),
					{ questions, answers, assessment, cancelled: false },
				);
			},
		});
	};
}

export function normalizeQuestions(value: unknown): StudentQuestion[] {
	if (!Array.isArray(value)) throw new Error("student_ask questions must be an array");
	return value.map((question, index) => {
		if (!question || typeof question !== "object") throw new Error(`Question ${index + 1} is invalid`);
		const candidate = question as Record<string, unknown>;
		if (typeof candidate.id !== "string" || typeof candidate.prompt !== "string" || !isQuestionCategory(candidate.category)) {
			throw new Error(`Question ${index + 1} has an invalid id, prompt, or category. category must be one of: ${QUESTION_CATEGORIES.join(", ")}`);
		}
		if (candidate.options !== undefined && (!Array.isArray(candidate.options) || candidate.options.some((option) => typeof option !== "string"))) {
			throw new Error(`Question ${index + 1} has invalid options`);
		}
		return {
			id: candidate.id,
			prompt: candidate.prompt,
			category: candidate.category,
			...(typeof candidate.label === "string" ? { label: candidate.label } : {}),
			...(typeof candidate.note === "string" ? { note: candidate.note } : {}),
			...(Array.isArray(candidate.options) ? { options: candidate.options as string[] } : {}),
			...(typeof candidate.allowCustom === "boolean" ? { allowCustom: candidate.allowCustom } : {}),
			...requiredField(candidate.required, index),
		};
	});
}

function requiredField(value: unknown, index: number): { required?: boolean } {
	try {
		const parsed = parseQuestionRequired(value);
		return parsed === undefined ? {} : { required: parsed };
	} catch (error) {
		throw new Error(`Question ${index + 1}: ${(error as Error).message}`);
	}
}

async function askQuestion(
	ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>>[4],
	question: StudentQuestion,
	title: string,
): Promise<string | undefined> {
	let prompt = question.note ? `${question.prompt}\n\n${question.note}` : question.prompt;
	if (question.options && question.options.length > 0) {
		const customLabel = "Other — type a custom response";
		const options = question.allowCustom ? [...question.options, customLabel] : question.options;
		const selected = await ctx.ui.select(`${title}\n${prompt}`, options);
		if (selected === undefined) return undefined;
		if (question.allowCustom && selected === customLabel) {
			while (true) {
				const answer = await ctx.ui.input(`${title}\n${prompt}`, "Type your own response");
				if (answer === undefined || !isQuestionRequired(question) || answer.trim()) return answer;
				prompt = `${question.prompt}\n\nA response is required to continue. Please enter a concrete answer.`;
			}
		}
		return selected;
	}
	while (true) {
		const answer = await ctx.ui.input(`${title}\n${prompt}`, "Type your answer");
		if (answer === undefined || !isQuestionRequired(question) || answer.trim()) return answer;
		prompt = `${question.prompt}\n\nA response is required to continue. Please enter a concrete answer.`;
	}
}

function categoryLabel(category: QuestionCategory): string {
	return category.charAt(0).toUpperCase() + category.slice(1);
}
