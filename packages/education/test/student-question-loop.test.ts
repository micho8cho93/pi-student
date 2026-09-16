import { describe, expect, it } from "vitest";
import { StudentQuestionLoop } from "@pi-student/education/student-question-loop";

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

	it("scales down to one meaningful question for a trivial file request", async () => {
		const loop = new StudentQuestionLoop();
		const questions = await loop.buildQuestions({
			stage: "understand",
			studentMessage: "Create index.html displaying Hello, world!",
		});
		expect(questions).toHaveLength(1);
	});
});
