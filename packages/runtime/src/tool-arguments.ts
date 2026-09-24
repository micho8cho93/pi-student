import type { Static } from "typebox";
import type { QuestionCategory } from "@pi-student/education/question-context";
import type { LearningStage } from "@pi-student/education/types";
import type { SaveToDesktopParams, StudentAskParams, StudentPlanParams } from "./tool-parameter-schemas.js";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function firstString(value: RecordValue, keys: string[]): string | undefined {
	for (const key of keys) {
		if (typeof value[key] === "string") return value[key];
	}
	return undefined;
}

function token(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
}

const QUESTION_CATEGORY_ALIASES: Record<string, QuestionCategory> = {
	requirement: "requirements",
	requirements: "requirements",
	goal: "requirements",
	goals: "requirements",
	needs: "requirements",
	design: "architecture",
	architecture_and_design: "architecture",
	architecture: "architecture",
	technical: "architecture",
	stack: "architecture",
	code: "implementation",
	coding: "implementation",
	javascript: "implementation",
	build: "implementation",
	implementation: "implementation",
	technical_implementation: "implementation",
	javascript_logic: "implementation",
	implementation_choice: "tradeoffs",
	file_structure: "architecture",
	safety: "security",
	privacy: "security",
	security: "security",
	test: "testing",
	tests: "testing",
	qa: "testing",
	testing: "testing",
	deploy: "deployment",
	hosting: "deployment",
	deployment: "deployment",
	debug: "debugging",
	bug: "debugging",
	error: "debugging",
	debugging: "debugging",
	tradeoff: "tradeoffs",
	tradeoffs: "tradeoffs",
	choice: "tradeoffs",
	options: "tradeoffs",
	predict: "prediction",
	expectation: "prediction",
	prediction: "prediction",
	reflect: "reflection",
	reflection: "reflection",
	command: "terminal",
	cli: "terminal",
	shell: "terminal",
	terminal: "terminal",
	git: "terminal",
	critique: "review",
	review: "review",
};

/**
 * Normalize the common action vocabulary used by smaller models before Pi's
 * strict TypeBox validation runs. Unknown actions are reduced to status so
 * they cannot accidentally mutate the student's plan.
 */
export function prepareStudentPlanArguments(args: unknown): Static<typeof StudentPlanParams> {
	const input = asRecord(args);
	const description = firstString(input, ["description", "step", "text", "planStep"]);
	const action = token(input.action);
	const normalizedAction = action === "approve" || action === "accept" || action === "confirm" || action === "submit" || action === "yes"
		? "approve"
		: action === "status" || action === "get" || action === "show" || action === "inspect" || action === "list" || action === "review"
			? "status"
			: description !== undefined || action === "add_step" || action === "add" || action === "create" || action === "new" || action === "record" || action === "set" || action === "append" || action === "insert" || action === "update"
				? "add_step"
				: "status";

	return {
		action: normalizedAction,
		...(description !== undefined ? { description } : {}),
	} as Static<typeof StudentPlanParams>;
}

/**
 * Normalize question envelopes, field names, and category synonyms. This
 * keeps the student-facing question contract strict while making the model
 * boundary tolerant of harmless vocabulary differences.
 */
export function prepareStudentAskArguments(args: unknown): Static<typeof StudentAskParams> {
	const input = asRecord(args);
	const rawQuestions = Array.isArray(args)
		? args
		: Array.isArray(input.questions)
			? input.questions
			: input.question !== undefined
				? [input.question]
				: Array.isArray(input.prompts)
					? input.prompts
					: Array.isArray(input.items)
						? input.items
						: undefined;

	if (!rawQuestions) return {} as Static<typeof StudentAskParams>;

	const questions = rawQuestions
		.map((value, index) => {
			const question = typeof value === "string" ? { prompt: value } : asRecord(value);
			const prompt = firstString(question, ["prompt", "question", "text", "title"]);
			if (!prompt?.trim()) return undefined;
			const rawOptions = Array.isArray(question.options) ? question.options : question.choices;
			const options = Array.isArray(rawOptions)
				? [...new Set(rawOptions.filter((option): option is string => typeof option === "string" && option.trim().length > 0))].slice(0, 6)
				: undefined;
			const categoryToken = token(question.category ?? question.type ?? question.topic);
			return {
				id: firstString(question, ["id", "key", "name"])?.trim() || `question-${index + 1}`,
				prompt: prompt.trim(),
				category: QUESTION_CATEGORY_ALIASES[categoryToken] ?? "requirements",
				...(typeof question.label === "string" ? { label: question.label } : {}),
				...(typeof question.note === "string" ? { note: question.note } : {}),
				...(options && options.length >= 2 ? { options } : {}),
				...(typeof question.allowCustom === "boolean" ? { allowCustom: question.allowCustom } : {}),
				...(typeof question.required === "boolean" ? { required: question.required } : {}),
			};
		})
		.filter((question): question is NonNullable<typeof question> => question !== undefined)
		.slice(0, 4);

	return questions.length > 0 ? { questions } as Static<typeof StudentAskParams> : {} as Static<typeof StudentAskParams>;
}

export function prepareLearningStateArguments(args: unknown, _fallbackStage: LearningStage): Record<string, unknown> {
	const input = asRecord(args);
	const readyValue = input.readyForNextStage ?? input.ready ?? input.complete ?? input.advance;
	const reason = firstString(input, ["reason", "explanation", "rationale", "summary"])?.trim() || "Continue the current stage with the available information.";
	const booleanValue = (value: unknown): boolean | undefined => {
		if (typeof value === "boolean") return value;
		if (typeof value !== "string") return undefined;
		if (["true", "yes", "ready", "complete", "completed"].includes(token(value))) return true;
		if (["false", "no", "not_ready", "incomplete"].includes(token(value))) return false;
		return undefined;
	};
	const readyForNextStage = booleanValue(readyValue) ?? false;
	const optionalBoolean = (keys: string[]): boolean | undefined => booleanValue(keys.map(key => input[key]).find(value => value !== undefined));
	const optionalString = (keys: string[]): string | undefined => firstString(input, keys)?.trim() || undefined;

	return {
		readyForNextStage,
		...(optionalString(["goalSummary", "goal", "objective"]) ? { goalSummary: optionalString(["goalSummary", "goal", "objective"]) } : {}),
		...(optionalBoolean(["understandingReady", "understood", "understandingComplete"]) !== undefined ? { understandingReady: optionalBoolean(["understandingReady", "understood", "understandingComplete"]) } : {}),
		...(optionalString(["planSummary", "plan", "summary"]) ? { planSummary: optionalString(["planSummary", "plan", "summary"]) } : {}),
		...(optionalBoolean(["reviewNeedsChanges", "needsChanges", "revisionRequired"]) !== undefined ? { reviewNeedsChanges: optionalBoolean(["reviewNeedsChanges", "needsChanges", "revisionRequired"]) } : {}),
		...(optionalString(["verificationStrategy", "verification", "testStrategy"]) ? { verificationStrategy: optionalString(["verificationStrategy", "verification", "testStrategy"]) } : {}),
		...(optionalBoolean(["verificationPassed", "passed", "testsPassed"]) !== undefined ? { verificationPassed: optionalBoolean(["verificationPassed", "passed", "testsPassed"]) } : {}),
		...(optionalBoolean(["reflectionComplete", "reflected"]) !== undefined ? { reflectionComplete: optionalBoolean(["reflectionComplete", "reflected"]) } : {}),
		reason,
	};
}

export function prepareSaveToDesktopArguments(args: unknown): Static<typeof SaveToDesktopParams> {
	const input = asRecord(args);
	const source = firstString(input, ["source", "path", "file", "filename"]);
	return {
		source: source?.trim() || ".",
		...(typeof input.filename === "string" ? { filename: input.filename } : {}),
	} as Static<typeof SaveToDesktopParams>;
}
