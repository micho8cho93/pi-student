import { describe, expect, it } from "vitest";
import {
	prepareLearningStateArguments,
	prepareSaveToDesktopArguments,
	prepareStudentAskArguments,
	prepareStudentPlanArguments,
} from "@pi-student/runtime/tool-arguments";

describe("model tool argument preparation", () => {
	it("turns common student_plan action aliases into canonical actions", () => {
		expect(prepareStudentPlanArguments({
			action: "add",
			description: "Create index.html, style.css, and script.js",
		})).toEqual({
			action: "add_step",
			description: "Create index.html, style.css, and script.js",
		});
		expect(prepareStudentPlanArguments({ action: "create", step: "Add the hero section" })).toEqual({
			action: "add_step",
			description: "Add the hero section",
		});
		expect(prepareStudentPlanArguments({ action: "unknown" })).toEqual({ action: "status" });
	});

	it("repairs student_ask envelopes, categories, and option bounds", () => {
		expect(prepareStudentAskArguments({
			question: {
				text: "Which visual direction should we use?",
				type: "design",
				choices: ["Classic", "Modern", "Experimental", "Extra", "Another", "Too many"],
			},
		})).toEqual({
			questions: [{
				id: "question-1",
				prompt: "Which visual direction should we use?",
				category: "architecture",
				options: ["Classic", "Modern", "Experimental", "Extra", "Another", "Too many"],
			}],
		});
	});

	it("fills the required learning_state envelope from model-friendly aliases", () => {
		expect(prepareLearningStateArguments({
			stage: "UNDERSTANDING",
			ready: "yes",
			goal: "Build a landing page",
			understood: true,
			explanation: "The goal and constraints are clear",
		}, "understand")).toEqual({
			readyForNextStage: true,
			currentStage: "understand",
			goalSummary: "Build a landing page",
			understandingReady: true,
			reason: "The goal and constraints are clear",
		});
	});

	it("accepts path as the source alias for Desktop export", () => {
		expect(prepareSaveToDesktopArguments({ path: "/workspace/index.html" })).toEqual({
			source: "/workspace/index.html",
		});
	});

	it("canonicalizes the required flag at the model boundary", () => {
		const ask = (required?: unknown) => prepareStudentAskArguments({ questions: [{ prompt: "Goal?", ...(required === undefined ? {} : { required }) }] }) as { questions: Array<Record<string, unknown>> };
		expect("required" in ask().questions[0]!).toBe(false);
		expect(ask(true).questions[0]!.required).toBe(true);
		expect(ask(false).questions[0]!.required).toBe(false);
		expect(ask("TRUE").questions[0]!.required).toBe(true);
		expect(ask("false").questions[0]!.required).toBe(false);
		// Unusable values are passed through so validation rejects them, never silently made optional.
		expect(ask("yes").questions[0]!.required).toBe("yes");
		expect(ask(1).questions[0]!.required).toBe(1);
	});

	it("normalizes stage names in learning_state arguments", () => {
		const prepared = (input: Record<string, unknown>) => prepareLearningStateArguments({ readyForNextStage: false, reason: "r", ...input }, "understand");
		expect(prepared({ currentStage: "PLAN", requestedNextStage: "Implementing" })).toMatchObject({ currentStage: "plan", requestedNextStage: "implement" });
		expect(prepared({ stage: "UNDERSTANDING" })).toMatchObject({ currentStage: "understand" });
		expect(prepared({})).not.toHaveProperty("currentStage");
		expect(prepared({ currentStage: "" })).not.toHaveProperty("currentStage");
		// Invalid values survive as text so learning_state can reject them with the allowed list.
		expect(prepared({ currentStage: "deploy" })).toMatchObject({ currentStage: "deploy" });
	});
});
