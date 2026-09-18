import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createLearningSession } from "@pi-student/education/types";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createStudentPlanExtension } from "@pi-student/runtime/student-plan";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function registerTool(controller: WorkflowController): RegisteredTool {
	let registered: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: RegisteredTool) {
			registered = tool;
		},
	} as unknown as ExtensionAPI;
	createStudentPlanExtension(controller)(pi);
	if (!registered) throw new Error("student_plan was not registered");
	return registered;
}

function enterPlan(controller: WorkflowController): void {
	controller.updateLearningState({
		currentStage: "understand",
		readyForNextStage: true,
		goalSummary: "Build a landing page",
		understandingReady: true,
		reason: "The goal is clear",
	});
}

describe("student_plan extension", () => {
	it("does not offer approval when the plan has no student-authored steps", async () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterPlan(controller);
		const confirm = vi.fn().mockResolvedValue(true);
		const tool = registerTool(controller);

		const response = await tool.execute("plan-1", { action: "approve" }, undefined, undefined, { ui: { confirm } } as never);

		expect(response).not.toHaveProperty("isError", true);
		expect(response.details).toMatchObject({ code: "PLAN_REQUIRES_STUDENT_STEP" });
		expect(response.details).toMatchObject({ recoverable: true });
		expect(response.details).toMatchObject({ nextAction: expect.stringContaining("select or type") });
		expect(confirm).not.toHaveBeenCalled();
		expect(controller.state.plan.approved).toBe(false);
	});

	it("asks for approval only after a student-authored step is recorded", async () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterPlan(controller);
		controller.addStudentPlanStep("Create the hero section");
		const confirm = vi.fn().mockResolvedValue(true);
		const tool = registerTool(controller);

		const response = await tool.execute("plan-2", { action: "approve" }, undefined, undefined, { ui: { confirm } } as never);

		expect(response).not.toHaveProperty("isError", true);
		expect(confirm).toHaveBeenCalledWith("Approve implementation plan?", "○ 1. Create the hero section");
		expect(controller.state.plan.approved).toBe(true);
	});
});
