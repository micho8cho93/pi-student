import { describe, expect, it } from "vitest";
import { classifyResponsibility } from "@pi-student/education/learning-boundary";

describe("Learning Boundary", () => {
	it.each([
		["create-file", "agent"],
		["run-tests", "agent"],
		["design-architecture", "together"],
		["debug-logic", "together"],
		["git-push", "student"],
		["git-commit", "student"],
	] as const)("classifies %s as %s", (action, expected) => {
		expect(classifyResponsibility({ action }).responsibility).toBe(expected);
	});

	it("lets an exercise mark an otherwise routine edit as learning-critical", () => {
		expect(classifyResponsibility({ action: "edit-code", learningCritical: true }).responsibility).toBe("together");
	});
});
