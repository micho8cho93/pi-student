import { describe, expect, it } from "vitest";
import { displayLearningStage, isLearningStage, LEARNING_STAGES, parseLearningStage } from "@pi-student/education/stage";

describe("learning stage canonical form", () => {
	it("keeps one lowercase canonical list", () => {
		expect(LEARNING_STAGES).toEqual(["understand", "plan", "implement", "review", "verify", "reflect"]);
		expect(isLearningStage("plan")).toBe(true);
		expect(isLearningStage("PLAN")).toBe(false);
	});

	it.each(LEARNING_STAGES)("accepts lowercase, uppercase and padded %s", stage => {
		expect(parseLearningStage(stage)).toBe(stage);
		expect(parseLearningStage(stage.toUpperCase())).toBe(stage);
		expect(parseLearningStage(`  ${stage[0]!.toUpperCase()}${stage.slice(1)} `)).toBe(stage);
	});

	it.each([
		["UNDERSTANDING", "understand"], ["planning", "plan"], ["Implementation", "implement"], ["implementing", "implement"],
		["reviewing", "review"], ["verification", "verify"], ["Verifying", "verify"], ["reflection", "reflect"], ["reflecting", "reflect"],
	])("normalizes the compatibility variant %s to %s", (input, expected) => {
		expect(parseLearningStage(input)).toBe(expected);
	});

	it("treats missing values as absent", () => {
		for (const value of [undefined, null, "", "   "]) expect(parseLearningStage(value)).toBeUndefined();
	});

	it("rejects invalid values instead of guessing", () => {
		for (const value of ["deploy", "plan;implement", "p", 3, {}, true]) {
			expect(() => parseLearningStage(value)).toThrow(/Valid stages: understand, plan, implement, review, verify, reflect/);
		}
	});

	it("only uppercases for display", () => {
		expect(displayLearningStage("verify")).toBe("VERIFY");
		expect(parseLearningStage(displayLearningStage("verify"))).toBe("verify");
	});
});
