import { describe, expect, it } from "vitest";
import { isQuestionCategory, QUESTION_CATEGORIES } from "@pi-student/education/question-context";
import { normalizeQuestions } from "@pi-student/runtime/student-ask";

describe("student question categories", () => {
	it("has one canonical category list and rejects invalid model output", () => {
		expect(isQuestionCategory("architecture")).toBe(true);
		expect(isQuestionCategory("future-work")).toBe(false);
		expect(new Set(QUESTION_CATEGORIES).size).toBe(QUESTION_CATEGORIES.length);
	});

	it("rejects invalid categories before a question can reach the UI", () => {
		expect(() => normalizeQuestions([{ id: "q1", prompt: "Future?", category: "future-work" }])).toThrow(/requirements.*architecture.*review/i);
	});
});
