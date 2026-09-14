import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createLearningStateExtension } from "../extensions/learning-state.js";
import { createLearningSession, type LearningStateUpdate } from "../workflow/types.js";
import { WorkflowController } from "../workflow/workflow-controller.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function registerLearningStateTool(controller: WorkflowController): RegisteredTool {
	let registered: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: RegisteredTool) {
			registered = tool;
		},
	} as unknown as ExtensionAPI;
	createLearningStateExtension(controller)(pi);
	if (!registered) throw new Error("learning_state was not registered");
	return registered;
}

async function execute(tool: RegisteredTool, update: LearningStateUpdate) {
	return tool.execute("call-1", update, undefined, undefined, {} as never);
}

describe("learning_state extension", () => {
	it("exposes a production bridge through the complete learning workflow", async () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		const tool = registerLearningStateTool(controller);

		expect(tool.name).toBe("learning_state");
		const response = await execute(tool, {
			currentStage: "understand",
			readyForNextStage: true,
			goalSummary: "Add a score counter",
			understandingReady: true,
			reason: "The goal is clear",
		});

		expect(response).not.toHaveProperty("isError", true);
		expect(controller.getStage()).toBe("plan");
		expect(response.content[0]).toMatchObject({ type: "text" });

		controller.addStudentPlanStep("Track score in game state");
		controller.approveStudentPlan("I reviewed and approve this step.");
		await execute(tool, {
			currentStage: "plan",
			readyForNextStage: true,
			planSummary: "Track score in game state",
			reason: "The student approved the plan",
		});
		await execute(tool, { currentStage: "implement", readyForNextStage: true, reason: "Implementation complete" });
		await execute(tool, { currentStage: "review", readyForNextStage: true, reason: "Review complete" });
		await execute(tool, {
			currentStage: "verify",
			readyForNextStage: true,
			verificationPassed: true,
			reason: "Verification passed",
		});
		const completed = await execute(tool, {
			currentStage: "reflect",
			readyForNextStage: true,
			reflectionComplete: true,
			reason: "Reflection complete",
		});

		expect(controller.getStage()).toBe("reflect");
		expect(controller.state.reflection.complete).toBe(true);
		expect(completed).not.toHaveProperty("isError", true);
	});

	it("returns controller failures as tool errors without mutating workflow state", async () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		const tool = registerLearningStateTool(controller);

		const response = await execute(tool, {
			currentStage: "understand",
			readyForNextStage: true,
			goalSummary: "Add a score counter",
			reason: "Understanding is not ready",
		});

		expect(response).toHaveProperty("isError", true);
		expect(controller.getStage()).toBe("understand");
		expect(controller.state.goal).toBeUndefined();
	});
});
