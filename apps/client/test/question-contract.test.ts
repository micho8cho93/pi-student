import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createStudentAskExtension } from "@pi-student/runtime/student-ask";
import { createReplUI } from "../src/terminal/repl.js";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

/**
 * Terminal and Paseo both reach students through the one shared student_ask
 * tool and the generic extension UI dialogs. This drives that tool through both
 * UI adapters with identical scripted answers and requires identical outcomes.
 */
function tool(): RegisteredTool {
	let registered: RegisteredTool | undefined;
	createStudentAskExtension()({ on: vi.fn(), registerTool(value: RegisteredTool) { registered = value; } } as unknown as ExtensionAPI);
	return registered!;
}

function terminalUI(answers: string[]) {
	const lines = (async function* () { yield* answers; })();
	const written: string[] = [];
	return { ui: createReplUI({} as ExtensionUIContext, lines, text => { written.push(text); }), written };
}

/** Pi RPC style dialog: the host answers each prompt in order; undefined means dismissed. */
function paseoUI(answers: string[]) {
	const queue = [...answers];
	const titles: string[] = [];
	const ui = { input: async (title: string) => { titles.push(title); return queue.shift(); }, select: async () => undefined } as unknown as ExtensionUIContext;
	return { ui, written: titles };
}

const adapters = [["terminal", terminalUI], ["paseo/rpc", paseoUI]] as const;

describe.each(adapters)("required questions through the %s interface", (_name, makeUI) => {
	const run = async (question: Record<string, unknown>, answers: string[]) => {
		const { ui, written } = makeUI(answers);
		const response = await tool().execute("call", { questions: [{ id: "q", prompt: "What must stay?", category: "requirements", ...question }] } as never, undefined, undefined, { ui } as never);
		return { response, written };
	};

	it("keeps asking a required question until it is answered", async () => {
		const { response, written } = await run({ required: true }, ["", "   ", "the public API"]);
		expect(response.details).toMatchObject({ answers: [{ questionId: "q", answer: "the public API" }] });
		expect(written.join("\n")).toContain("A response is required to continue");
	});

	it.each([["required: false", { required: false }], ["required omitted", {}]])("accepts a blank answer with %s", async (_label, question) => {
		const { response } = await run(question, [""]);
		expect(response.details).toMatchObject({ cancelled: false, answers: [{ questionId: "q", answer: "" }] });
	});

	it("rejects a non-boolean required flag identically", async () => {
		await expect(run({ required: "sometimes" }, ["x"])).rejects.toThrow(/required must be a boolean/);
	});
});
