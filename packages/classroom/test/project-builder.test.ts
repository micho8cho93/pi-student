import { describe, expect, it, vi } from "vitest";
import { createProjectBuilder, formatProjectBrief, normalizeProjectBrief } from "@pi-student/classroom/project-builder";

describe("teacher project builder", () => {
	it("normalizes a structured brief and formats it for the student harness", () => {
		const brief = normalizeProjectBrief({ goal: "Build a calculator", objectives: ["Practice DOM events"], structure: ["index.html", "app.js"], successCriteria: ["Four operations work"] });
		expect(brief.version).toBe(1);
		expect(formatProjectBrief(brief)).toContain("Goal: Build a calculator");
		expect(formatProjectBrief(brief)).toContain("Expected structure: index.html; app.js");
	});

	it("turns a JSON model response into a saveable draft", async () => {
		const runtime = { completeSimple: vi.fn(async () => ({ content: [{ type: "text", text: JSON.stringify({ message: "I have enough to build the brief.", ready: true, draft: { name: "Calculator", description: "Build a calculator.", brief: { goal: "Build a calculator", objectives: ["Practice DOM events"], expectations: "Explain the event flow", structure: ["index.html", "styles.css", "app.js"], constraints: ["Vanilla web APIs"], successCriteria: ["Add, subtract, multiply, and divide" ] }, requirements: [{ title: "Four operations", description: "Support the four basic operations." }], standards: [] } }) }] })) };
		const builder = createProjectBuilder(runtime as never, {} as never);
		const turn = await builder.turn([], "Students should build a calculator with vanilla HTML, CSS, and JS.");
		expect(turn.ready).toBe(true);
		expect(turn.draft).toMatchObject({ name: "Calculator", brief: { goal: "Build a calculator" } });
		expect(runtime.completeSimple).toHaveBeenCalledOnce();
	});
});
