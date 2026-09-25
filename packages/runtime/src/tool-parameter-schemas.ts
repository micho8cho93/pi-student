import { Type } from "typebox";
import { QUESTION_CATEGORIES } from "@pi-student/education/question-context";

// Keep this as a plain string for Google tool-schema compatibility. The
// prepareArguments hook canonicalizes the value before runtime validation.
export const QuestionCategorySchema = Type.String({
	description: `Educational category. Allowed values: ${QUESTION_CATEGORIES.join(", ")}`,
});

export const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier for this question" }),
	prompt: Type.String({ description: "The question the student should answer" }),
	category: QuestionCategorySchema,
	label: Type.Optional(Type.String({ description: "Short label shown in the prompt" })),
	note: Type.Optional(Type.String({ description: "Optional short explanation shown with the question" })),
	options: Type.Optional(Type.Array(Type.String(), { minItems: 2, maxItems: 6 })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow a custom response in addition to the options" })),
	required: Type.Optional(Type.Boolean({ description: "true = a non-blank answer is required to continue; false or omitted = optional" })),
});

export const StudentAskParams = Type.Object({
	questions: Type.Optional(Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 4,
		description: "One to four targeted questions; do not use this for trivial confirmations",
	})),
});

export const StudentPlanParams = Type.Object({
	action: Type.String({ description: "Plan action: add_step, approve, or status" }),
	description: Type.Optional(Type.String({ description: "A student-authored implementation step" })),
});

export const SaveToDesktopParams = Type.Object({
	source: Type.String({ description: "File inside /workspace to publish to the user's Desktop" }),
	filename: Type.Optional(Type.String({ description: "Optional filename to use on the Desktop; defaults to the source filename" })),
});
