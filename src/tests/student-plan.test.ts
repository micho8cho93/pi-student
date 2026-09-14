import { describe, expect, it } from "vitest";
import { addStudentPlanStep, approveStudentPlan, createStudentPlan, planProgress } from "../education/student-plan.js";

describe("StudentPlan", () => {
	it("records student-authored steps and requires explicit acknowledgement", () => {
		const plan = createStudentPlan();
		const step = addStudentPlanStep(plan, "Create the login form");

		expect(step.studentAuthored).toBe(true);
		expect(plan.approved).toBe(false);
		expect(() => approveStudentPlan(plan, "")).toThrow("student acknowledgement");

		approveStudentPlan(plan, "I understand and approve this step.");
		expect(plan.approved).toBe(true);
		expect(plan.studentAcknowledgements).toHaveLength(1);
		expect(() => addStudentPlanStep(plan, "Silently add persistence")).toThrow("approved student plan");
	});

	it("reports checklist progress", () => {
		const plan = createStudentPlan();
		addStudentPlanStep(plan, "Create the form");
		addStudentPlanStep(plan, "Verify the form");
		plan.steps[0].status = "complete";
		expect(planProgress(plan)).toEqual({ complete: 1, total: 2 });
	});
});
