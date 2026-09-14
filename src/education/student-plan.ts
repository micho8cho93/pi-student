import type { EngineeringConcern } from "./engineering-concern.js";

export type PlanStepStatus = "pending" | "active" | "complete" | "blocked";

export interface PlanStep {
	id: string;
	description: string;
	status: PlanStepStatus;
	studentAuthored: boolean;
}

export interface StudentPlan {
	steps: PlanStep[];
	approved: boolean;
	concerns: EngineeringConcern[];
	studentAcknowledgements: string[];
	summary?: string;
}

export function createStudentPlan(): StudentPlan {
	return {
		steps: [],
		approved: false,
		concerns: [],
		studentAcknowledgements: [],
	};
}

/** Add a step only from text supplied by the student. */
export function addStudentPlanStep(plan: StudentPlan, description: string): PlanStep {
	const normalized = description.trim();
	if (!normalized) throw new Error("A student plan step must contain a description");
	if (plan.approved) throw new Error("An approved student plan cannot be changed without returning to PLAN");

	const step: PlanStep = {
		id: `step-${plan.steps.length + 1}`,
		description: normalized,
		status: "pending",
		studentAuthored: true,
	};
	plan.steps.push(step);
	return step;
}

export function approveStudentPlan(plan: StudentPlan, acknowledgement: string): void {
	const normalized = acknowledgement.trim();
	if (plan.steps.length === 0) throw new Error("A student plan needs at least one step before approval");
	if (!normalized) throw new Error("Plan approval requires a student acknowledgement");

	plan.approved = true;
	plan.studentAcknowledgements.push(normalized);
}

export function planProgress(plan: StudentPlan): { complete: number; total: number } {
	return {
		complete: plan.steps.filter((step) => step.status === "complete").length,
		total: plan.steps.length,
	};
}

export function formatStudentPlan(plan: StudentPlan): string {
	if (plan.steps.length === 0) return "(no student-authored steps yet)";
	return plan.steps
		.map((step, index) => {
			const marker = step.status === "complete" ? "✓" : step.status === "active" ? "→" : step.status === "blocked" ? "!" : "○";
			return `${marker} ${index + 1}. ${step.description}`;
		})
		.join("\n");
}
