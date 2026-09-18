import { describe, expect, it } from "vitest";
import { addStudentPlanStep, approveStudentPlan, createStudentPlan, hasStudentAuthoredSteps, planProgress } from "@pi-student/education/student-plan";

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

	it("does not treat non-student steps as approval evidence", () => {
		const plan = createStudentPlan();
		plan.steps.push({ id: "model-step", description: "Model-only step", status: "pending", studentAuthored: false });

		expect(hasStudentAuthoredSteps(plan)).toBe(false);
		expect(() => approveStudentPlan(plan, "I approve this plan.")).toThrow("student-authored step");
	});

	it("reports checklist progress", () => {
		const plan = createStudentPlan();
		addStudentPlanStep(plan, "Create the form");
		addStudentPlanStep(plan, "Verify the form");
		plan.steps[0].status = "complete";
		expect(planProgress(plan)).toEqual({ complete: 1, total: 2 });
	});
});
