import { describe, expect, it } from "vitest";
import { StudentQuestionLoop } from "@pi-student/education/student-question-loop";
import { isQuestionRequired, parseQuestionRequired } from "@pi-student/education/question-context";

describe("StudentQuestionLoop", () => {
	it("repeats with a targeted next round when required information is missing", async () => {
		const loop = new StudentQuestionLoop();
		const firstRound = await loop.buildQuestions({ stage: "understand", studentMessage: "I want authentication" });
		const firstAssessment = await loop.processAnswers(
			firstRound,
			firstRound.map((question, index) => ({ questionId: question.id, answer: index === 0 ? "" : "Keep the existing app" })),
		);

		expect(firstAssessment.sufficientInformation).toBe(false);
		const nextDecision = await loop.evaluate({
			stage: "understand",
			studentMessage: "I want authentication",
			questionRound: 1,
			previousQuestions: firstRound,
			previousAnswers: [],
		});
		expect(nextDecision.shouldAsk).toBe(true);
		const secondRound = await loop.buildQuestions({
			stage: "understand",
			studentMessage: "I want authentication",
			questionRound: 1,
			previousQuestions: firstRound,
		});
		expect(secondRound.every((question) => !firstRound.some((previous) => previous.prompt === question.prompt))).toBe(true);
	});

	it("stops when all required questions have answers", async () => {
		const loop = new StudentQuestionLoop();
		const questions = await loop.buildQuestions({ stage: "plan", studentMessage: "Add authentication" });
		const assessment = await loop.processAnswers(questions, questions.map((question) => ({ questionId: question.id, answer: "The student decision" })));

		expect(assessment.sufficientInformation).toBe(true);
		expect((await loop.evaluate({ stage: "plan", informationSufficient: true })).shouldAsk).toBe(false);
	});

	describe("required contract", () => {
		const blank = (questionId: string) => [{ questionId, answer: "" }];

		it("leaves a blank answer unresolved only when required is explicitly true", async () => {
			const loop = new StudentQuestionLoop();
			const questions = [{ id: "q", prompt: "What must stay unchanged?", category: "requirements" as const, required: true }];
			const result = await loop.processAnswers(questions, blank("q"));
			expect(result.sufficientInformation).toBe(false);
			expect(result.unresolvedIssues).toEqual(["What must stay unchanged?"]);
		});

		it("treats an omitted required flag as optional", async () => {
			const loop = new StudentQuestionLoop();
			const question = { id: "q", prompt: "Anything else?", category: "reflection" as const };
			expect("required" in question).toBe(false);
			expect(isQuestionRequired(question)).toBe(false);
			expect((await loop.processAnswers([question], blank("q"))).sufficientInformation).toBe(true);
		});

		it("treats required: false as optional", async () => {
			const loop = new StudentQuestionLoop();
			const question = { id: "q", prompt: "Anything else?", category: "reflection" as const, required: false };
			expect(isQuestionRequired(question)).toBe(false);
			expect((await loop.processAnswers([question], blank("q"))).sufficientInformation).toBe(true);
		});

		it("does not use JS truthiness for the flag", () => {
			for (const value of ["true", 1, "yes", {}, [], "false", 0, null, undefined]) {
				expect(isQuestionRequired({ required: value as never })).toBe(false);
			}
			expect(isQuestionRequired({ required: true })).toBe(true);
		});

		it("parses the input boundary: omitted, booleans, exact boolean strings, and rejects the rest", () => {
			expect(parseQuestionRequired(undefined)).toBeUndefined();
			expect(parseQuestionRequired(true)).toBe(true);
			expect(parseQuestionRequired(false)).toBe(false);
			expect(parseQuestionRequired(" TRUE ")).toBe(true);
			expect(parseQuestionRequired("false")).toBe(false);
			for (const bad of ["yes", "", 1, 0, null, {}, []]) expect(() => parseQuestionRequired(bad)).toThrow(/boolean/);
		});
	});

	it("scales down to one meaningful question for a trivial file request", async () => {
		const loop = new StudentQuestionLoop();
		const questions = await loop.buildQuestions({
			stage: "understand",
			studentMessage: "Create index.html displaying Hello, world!",
		});
		expect(questions).toHaveLength(1);
	});
});
