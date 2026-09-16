import { describe, expect, it } from "vitest";
import { createLearningSession } from "@pi-student/education/types";
import { InvalidTransitionError, LearningStateError, WorkflowController } from "@pi-student/education/workflow-controller";

function enterPlan(controller: WorkflowController): void {
	controller.updateLearningState({
		currentStage: "understand",
		readyForNextStage: true,
		goalSummary: "Add a score counter",
		understandingReady: true,
		reason: "The goal and requirements are clear",
	});
}

function enterImplement(controller: WorkflowController): void {
	enterPlan(controller);
	controller.addStudentPlanStep("Track score in game state");
	controller.approveStudentPlan("I reviewed the step and approve it.");
	controller.updateLearningState({
		currentStage: "plan",
		readyForNextStage: true,
		planSummary: "Track score in game state",
		reason: "The student approved the plan",
	});
}

function enterVerify(controller: WorkflowController): void {
	enterImplement(controller);
	controller.updateLearningState({ currentStage: "implement", readyForNextStage: true, reason: "Implementation complete" });
	controller.updateLearningState({ currentStage: "review", readyForNextStage: true, reason: "Review complete" });
}

describe("WorkflowController", () => {
	it("owns stage changes and rejects illegal transitions atomically", () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		expect(controller.getStage()).toBe("understand");
		expect(() => controller.updateLearningState({
			currentStage: "understand",
			readyForNextStage: true,
			goalSummary: "Add a score counter",
			understandingReady: true,
			requestedNextStage: "implement",
			reason: "Skip planning",
		})).toThrow(InvalidTransitionError);
		expect(controller.getStage()).toBe("understand");
		expect(controller.state.goal).toBeUndefined();
		expect(controller.state.understanding.ready).toBe(false);
	});

	it("accepts understanding progress and enters PLAN", () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		expect(() => controller.updateLearningState({
			currentStage: "understand",
			readyForNextStage: true,
			goalSummary: "Add a score counter",
			reason: "Not enough context",
		})).toThrow(LearningStateError);
		expect(controller.state.goal).toBeUndefined();

		enterPlan(controller);
		expect(controller.getStage()).toBe("plan");
	});

	it("requires an explicitly approved plan before IMPLEMENT", () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterPlan(controller);

		expect(() => controller.updateLearningState({ currentStage: "plan", readyForNextStage: true, planSummary: "Track score in game state", reason: "Plan drafted" })).toThrow(LearningStateError);
		expect(controller.state.plan.summary).toBeUndefined();

		controller.addStudentPlanStep("Track score in game state");
		controller.approveStudentPlan("I reviewed the step and approve it.");
		controller.updateLearningState({
			currentStage: "plan",
			readyForNextStage: true,
			planSummary: "Track score in game state",
			reason: "Student approved the plan",
		});
		expect(controller.getStage()).toBe("implement");
	});

	it("does not accept model-reported plan approval", () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterPlan(controller);
		controller.addStudentPlanStep("Track score in game state");

		expect(() => controller.updateLearningState({
			currentStage: "plan",
			readyForNextStage: false,
			studentApprovedPlan: true,
			reason: "The model says the plan is approved",
		})).toThrow("cannot approve a plan");
		expect(controller.state.plan.approved).toBe(false);
	});

	it("reopens an approved plan when implementation requests replanning", () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterImplement(controller);

		controller.updateLearningState({
			currentStage: "implement",
			readyForNextStage: true,
			requestedNextStage: "plan",
			reason: "The implementation exposed a missing step",
		});

		expect(controller.getStage()).toBe("plan");
		expect(controller.state.plan.approved).toBe(false);
		expect(controller.state.plan.summary).toBeUndefined();
		expect(() => controller.addStudentPlanStep("Handle the newly discovered edge case")).not.toThrow();
	});

	it("allows verification to return to implementation or proceed to reflection", () => {
		const failed = new WorkflowController(createLearningSession("/tmp/project"));
		enterVerify(failed);
		failed.updateLearningState({ currentStage: "verify", readyForNextStage: true, verificationPassed: false, reason: "Tests failed" });
		expect(failed.getStage()).toBe("implement");

		const passed = new WorkflowController(createLearningSession("/tmp/project"));
		enterVerify(passed);
		passed.updateLearningState({ currentStage: "verify", readyForNextStage: false, verificationPassed: true, reason: "Tests passed" });
		passed.updateLearningState({ currentStage: "verify", readyForNextStage: true, reason: "Use the recorded result" });
		expect(passed.getStage()).toBe("reflect");
	});

	it("rejects a verification target that contradicts the result", () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterVerify(controller);

		expect(() => controller.updateLearningState({
			currentStage: "verify",
			readyForNextStage: true,
			verificationPassed: false,
			requestedNextStage: "reflect",
			reason: "Ignore the failed result",
		})).toThrow(LearningStateError);
		expect(controller.getStage()).toBe("verify");
		expect(controller.state.verification.passed).toBeUndefined();
	});

	it("records reflection completion in the terminal stage", () => {
		const controller = new WorkflowController(createLearningSession("/tmp/project"));
		enterVerify(controller);
		controller.updateLearningState({ currentStage: "verify", readyForNextStage: true, verificationPassed: true, reason: "Tests passed" });
		controller.updateLearningState({ currentStage: "reflect", readyForNextStage: true, reflectionComplete: true, reason: "Reflection complete" });

		expect(controller.getStage()).toBe("reflect");
		expect(controller.state.reflection.complete).toBe(true);
	});
});
