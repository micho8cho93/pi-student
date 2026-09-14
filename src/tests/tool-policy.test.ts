import { describe, expect, it } from "vitest";
import { toolPolicy } from "../workflow/tool-policy.js";

describe("stage tool policy", () => {
	it("registers the union needed across the complete workflow", () => {
		const registered = toolPolicy.registeredTools();

		expect(new Set(registered).size).toBe(registered.length);
		expect(registered).toEqual(expect.arrayContaining([
			"student_ask",
			"student_plan",
			"learning_state",
			"read",
			"edit",
			"write",
			"bash",
		]));
	});

	it.each(["understand", "plan", "implement", "review", "verify", "reflect"] as const)("%s can report progress and request a transition", (stage) => {
		expect(toolPolicy.canUseTool(stage, "learning_state")).toBe(true);
	});

	it.each(["understand", "plan", "reflect"] as const)("%s is read-only apart from safe inspection bash", (stage) => {
		expect(toolPolicy.canUseTool(stage, "read")).toBe(true);
		expect(toolPolicy.canUseTool(stage, "grep")).toBe(true);
		expect(toolPolicy.canUseTool(stage, "find")).toBe(true);
		expect(toolPolicy.canUseTool(stage, "ls")).toBe(true);
		expect(toolPolicy.canUseTool(stage, "edit")).toBe(false);
		expect(toolPolicy.canUseTool(stage, "write")).toBe(false);
		expect(toolPolicy.canUseTool(stage, "bash")).toBe(true);
	});

	it("IMPLEMENT enables all coding tools", () => {
		for (const tool of ["read", "grep", "find", "ls", "edit", "write", "bash"]) {
			expect(toolPolicy.canUseTool("implement", tool)).toBe(true);
		}
	});

	it("VERIFY allows inspection, verification commands, and fixes", () => {
		expect(toolPolicy.canUseTool("verify", "read")).toBe(true);
		expect(toolPolicy.canUseTool("verify", "bash")).toBe(true);
		expect(toolPolicy.canUseTool("verify", "edit")).toBe(true);
		expect(toolPolicy.canUseTool("verify", "write")).toBe(true);
	});

	it("REVIEW is read-only but can ask educational questions", () => {
		expect(toolPolicy.canUseTool("review", "student_ask")).toBe(true);
		expect(toolPolicy.canUseTool("review", "read")).toBe(true);
		expect(toolPolicy.canUseTool("review", "edit")).toBe(false);
		expect(toolPolicy.canUseTool("review", "write")).toBe(false);
		expect(toolPolicy.canUseTool("review", "bash")).toBe(true);
	});

	it("exposes Desktop export only during REFLECT, after verification can have passed", () => {
		expect(toolPolicy.canUseTool("verify", "save_to_desktop")).toBe(false);
		expect(toolPolicy.canUseTool("reflect", "save_to_desktop")).toBe(true);
	});
});
