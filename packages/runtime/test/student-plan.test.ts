import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createLearningSession } from "@pi-student/education/types";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createStudentPlanExtension } from "@pi-student/runtime/student-plan";
import { prepareStudentPlanArguments } from "@pi-student/runtime/tool-arguments";

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
	it("executes the reported add action after harness normalization", async () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterPlan(controller);
		const confirm = vi.fn().mockResolvedValue(true);
		const tool = registerTool(controller);
		const rawArgs = { action: "add", description: "Create index.html" };

		await tool.execute("plan-alias", prepareStudentPlanArguments(rawArgs), undefined, undefined, { ui: { confirm } } as never);
		await tool.execute("plan-approve", prepareStudentPlanArguments({ action: "approve" }), undefined, undefined, { ui: { confirm } } as never);

		expect(controller.state.plan.steps).toHaveLength(1);
		expect(controller.state.plan.steps[0]).toMatchObject({ description: "Create index.html", studentAuthored: true });
		expect(confirm).toHaveBeenCalledWith("Add this student-authored plan step?", "Create index.html");
		expect(confirm).toHaveBeenCalledWith("Approve implementation plan?", "○ 1. Create index.html");
	});

	it("does not offer approval when the plan has no student-authored steps", async () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterPlan(controller);
		const confirm = vi.fn().mockResolvedValue(true);
		const tool = registerTool(controller);

		await expect(tool.execute("plan-1", { action: "approve" }, undefined, undefined, { ui: { confirm } } as never))
			.rejects.toMatchObject({ name: "ToolExecutionError", message: expect.stringContaining("PLAN_REQUIRES_STUDENT_STEP") });
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
