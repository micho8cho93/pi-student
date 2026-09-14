import { describe, expect, it } from "vitest";
import { routeIntent } from "../education/intent.js";
import { StudentQuestionLoop } from "../education/student-question-loop.js";

describe("intent router", () => {
	it.each([
		["I want to create a portfolio website.", "BUILD"],
		["Why does recursion need a base case?", "EXPLAIN"],
		["My API keeps returning 500.", "DEBUG"],
		["Can you look over my code?", "CHECK"],
		["Help me figure out how to write this function.", "TUTOR"],
	] as const)("routes %s to %s", (message, expected) => {
		expect(routeIntent(message).intent).toBe(expected);
	});

	it("leaves genuinely ambiguous prompts available for clarification", () => {
		const route = routeIntent("I need help with my project");
		expect(route.ambiguous).toBe(true);
		expect(route.intent).toBeUndefined();
	});

	it("keeps the established intent for a short continuation", () => {
		const route = routeIntent("go ahead", { currentIntent: "BUILD" });
		expect(route.ambiguous).toBe(false);
		expect(route.intent).toBe("BUILD");
	});

	it("starts an ambiguous question round with a simple learning-approach choice", async () => {
		const questions = await new StudentQuestionLoop().buildQuestions({
			stage: "understand",
			intentAmbiguous: true,
			studentMessage: "I need help with my project",
		});
		expect(questions[0]?.prompt).toBe("What kind of help would be most useful right now?");
	});
});

describe("intent-specific questions", () => {
	it.each(["BUILD", "TUTOR", "EXPLAIN", "DEBUG", "CHECK"] as const)("offers four questions for %s", async (intent) => {
		const questions = await new StudentQuestionLoop().buildQuestions({
			stage: "understand",
			intent,
			studentMessage: "A substantive student request",
		});
		expect(questions).toHaveLength(4);
	});

	it("asks four contextual Build questions and avoids asking which language when it is detected", async () => {
		const loop = new StudentQuestionLoop();
		const questions = await loop.buildQuestions({
			stage: "understand",
			intent: "BUILD",
			studentMessage: "I want a portfolio website",
			projectContext: {
				languages: ["JavaScript", "HTML/CSS"],
				frameworks: [],
				projectType: "web project",
				packageManager: undefined,
				testFramework: undefined,
				hasGit: false,
				importantFiles: ["index.html", "styles.css", "script.js"],
			},
		});

		expect(questions).toHaveLength(4);
		expect(questions.some((question) => /which programming language/i.test(question.prompt))).toBe(false);
		expect(questions[2]?.prompt).toMatch(/JavaScript|HTML\/CSS/);
	});
});
