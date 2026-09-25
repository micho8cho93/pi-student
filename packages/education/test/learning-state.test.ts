import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createLearningStateExtension } from "@pi-student/runtime/learning-state";
import { createLearningSession, type LearningStateUpdate } from "@pi-student/education/types";
import { WorkflowController } from "@pi-student/education/workflow-controller";

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

		await expect(execute(tool, {
			currentStage: "understand",
			readyForNextStage: true,
			goalSummary: "Add a score counter",
			reason: "Understanding is not ready",
		})).rejects.toThrow(/LEARNING_STATE_REJECTED.*understandingReady/s);

		expect(controller.getStage()).toBe("understand");
		expect(controller.state.goal).toBeUndefined();
	});

	it("rejects model-reported plan approval with a recoverable instruction", async () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		const tool = registerLearningStateTool(controller);
		await expect(execute(tool, {
			currentStage: "understand",
			readyForNextStage: false,
			studentApprovedPlan: true,
			reason: "The model approved the plan",
		})).rejects.toThrow(/LEARNING_STATE_REJECTED.*understandingReady/s);

		expect(controller.getStage()).toBe("understand");
	});

	describe("stage input boundary", () => {
		const call = (tool: RegisteredTool, params: Record<string, unknown>) => tool.execute("call-1", { readyForNextStage: false, reason: "test", ...params } as never, undefined, undefined, {} as never);

		it("uses the harness stage when none is supplied", async () => {
			const controller = new WorkflowController(createLearningSession("/tmp/project"));
			const tool = registerLearningStateTool(controller);
			const response = await call(tool, { goalSummary: "Add a counter" });
			expect(response.details).toMatchObject({ previousStage: "understand", currentStage: "understand" });
		});

		it.each(["understand", "UNDERSTAND", " Understand ", "understanding"])("accepts %s as the current stage", async stage => {
			const controller = new WorkflowController(createLearningSession("/tmp/project"));
			const tool = registerLearningStateTool(controller);
			const response = await call(tool, { currentStage: stage, goalSummary: "Add a counter", understandingReady: true, readyForNextStage: true });
			expect(response.details).toMatchObject({ previousStage: "understand", currentStage: "plan" });
			// One canonical representation everywhere after the boundary.
			expect(controller.getStage()).toBe("plan");
			expect(controller.state.stage).toBe("plan");
		});

		it("rejects an unknown stage and leaves runtime state untouched", async () => {
			const controller = new WorkflowController(createLearningSession("/tmp/project"));
			const tool = registerLearningStateTool(controller);
			await expect(call(tool, { currentStage: "deploy" })).rejects.toThrow(/Unknown learning stage "deploy".*LEARNING_STATE_REJECTED/s);
			await expect(call(tool, { requestedNextStage: "launch" })).rejects.toThrow(/Unknown learning stage/);
			expect(controller.getStage()).toBe("understand");
		});

		it("rejects a valid but stale stage instead of silently using the harness stage", async () => {
			const controller = new WorkflowController(createLearningSession("/tmp/project"));
			const tool = registerLearningStateTool(controller);
			await expect(call(tool, { currentStage: "implement" })).rejects.toThrow(/Stale learning update/);
			expect(controller.getStage()).toBe("understand");
		});

		it("does not let a requested stage skip controller gates", async () => {
			const controller = new WorkflowController(createLearningSession("/tmp/project"));
			const tool = registerLearningStateTool(controller);
			await expect(call(tool, { requestedNextStage: "IMPLEMENT", readyForNextStage: true, goalSummary: "x", understandingReady: true })).rejects.toThrow(/LEARNING_STATE_REJECTED|Illegal/);
			expect(controller.getStage()).toBe("understand");
		});
	});
});
