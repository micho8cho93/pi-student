import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createStudentAskExtension } from "../extensions/student-ask.js";

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
});
