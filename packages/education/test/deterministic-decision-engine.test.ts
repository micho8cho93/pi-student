import { describe, expect, it } from "vitest";
import { boundedStudentContext } from "@pi-student/decision";
import { DeterministicDecisionEngine, EDUCATIONAL_INTENT_CHOICES } from "../src/deterministic-decision-engine.js";
import { routeIntent } from "../src/intent.js";
import { StudentQuestionLoop } from "../src/student-question-loop.js";

describe("production deterministic decision engine", () => {
	it("preserves the established intent route and continuation", () => {
		const engine = new DeterministicDecisionEngine();
		for (const message of ["Build a quiz app", "Explain closures", "My test fails", "Review this code", "Help me work through it"]) {
			expect(engine.routeIntent(message)).toEqual(routeIntent(message));
		}
		expect(engine.routeIntent("go ahead", { currentIntent: "BUILD" }).intent).toBe("BUILD");
	});
	it("implements bounded intent choice and abstains on ambiguous input", async () => {
		const engine = new DeterministicDecisionEngine();
		expect((await engine.choose(boundedStudentContext("student-intent", "Build a quiz app"), "Which intent?", EDUCATIONAL_INTENT_CHOICES)).value).toBe("BUILD");
		expect((await engine.choose(boundedStudentContext("student-intent", "Can you help?"), "Which intent?", EDUCATIONAL_INTENT_CHOICES)).fallbackUsed).toBe(true);
	});
	it("abstains on sufficiency, keeping the existing question flow authoritative", async () => {
		const engine = new DeterministicDecisionEngine();
		expect((await engine.yesNo(boundedStudentContext("context-sufficiency", "Build a quiz app"), "Enough?" )).fallbackUsed).toBe(true);
		const loop = new StudentQuestionLoop(engine);
		expect((await loop.evaluate({ stage: "understand", intent: "BUILD", studentMessage: "Build a quiz app" })).shouldAsk).toBe(true);
		expect((await loop.evaluate({ stage: "understand", intent: "BUILD", studentMessage: "Build a quiz app", informationSufficient: true })).shouldAsk).toBe(false);
	});
});
