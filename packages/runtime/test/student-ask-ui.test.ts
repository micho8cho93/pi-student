import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createStudentAskExtension } from "@pi-student/runtime/student-ask";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

describe("student question interface boundary", () => {
	it("uses generic extension UI dialogs that terminal and Pi RPC can both render", async () => {
		let tool: RegisteredTool | undefined;
		const pi = {
			on: vi.fn(),
			registerTool(value: RegisteredTool) { tool = value; },
		} as unknown as ExtensionAPI;
		createStudentAskExtension()(pi);
		const select = vi.fn().mockResolvedValue("Portfolio");
		const input = vi.fn().mockResolvedValue("No backend");
		const response = await tool!.execute("ask-1", {
			questions: [
				{ id: "kind", prompt: "What kind of website?", category: "requirements", options: ["Portfolio", "Blog"] },
				{ id: "backend", prompt: "Will it need a backend?", category: "architecture" },
			],
		} as never, undefined, undefined, { ui: { select, input } } as never);

		expect(select).toHaveBeenCalledWith(expect.stringContaining("What kind of website?"), ["Portfolio", "Blog"]);
		expect(input).toHaveBeenCalledWith(expect.stringContaining("Will it need a backend?"), "Type your answer");
		expect(response.details).toMatchObject({
			cancelled: false,
			answers: [
				{ questionId: "kind", answer: "Portfolio" },
				{ questionId: "backend", answer: "No backend" },
			],
		});
	});

	it("re-prompts for a blank required answer without returning a tool error", async () => {
		let tool: RegisteredTool | undefined;
		const pi = {
			on: vi.fn(),
			registerTool(value: RegisteredTool) { tool = value; },
		} as unknown as ExtensionAPI;
		createStudentAskExtension()(pi);
		const input = vi.fn()
			.mockResolvedValueOnce("   ")
			.mockResolvedValueOnce("Keep the existing API");

		const response = await tool!.execute("ask-2", {
			questions: [{ id: "constraint", prompt: "What must remain unchanged?", category: "requirements", required: true }],
		} as never, undefined, undefined, { ui: { input } } as never);

		expect(input).toHaveBeenCalledTimes(2);
		expect(input.mock.calls[1]?.[0]).toContain("A response is required to continue");
		expect(response).not.toHaveProperty("isError", true);
		expect(response.details).toMatchObject({ answers: [{ answer: "Keep the existing API" }] });
	});

	it("treats cancellation as a normal recoverable outcome", async () => {
		let tool: RegisteredTool | undefined;
		const pi = {
			on: vi.fn(),
			registerTool(value: RegisteredTool) { tool = value; },
		} as unknown as ExtensionAPI;
		createStudentAskExtension()(pi);
		const response = await tool!.execute("ask-3", {
			questions: [{ id: "goal", prompt: "What should it do?", category: "requirements" }],
		} as never, undefined, undefined, { ui: { input: vi.fn().mockResolvedValue(undefined) } } as never);

		expect(response).not.toHaveProperty("isError", true);
		expect(response.details).toMatchObject({ cancelled: true, recoverable: true, stopped: true });
	});

});
