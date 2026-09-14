import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LearningAgentSession } from "../pi/create-session.js";
import { runRepl } from "../terminal/repl.js";
import { createLearningSession } from "../workflow/types.js";
import { WorkflowController } from "../workflow/workflow-controller.js";

describe("plain terminal fallback", () => {
	it("renders provider failures delivered through the assistant event stream", async () => {
		let listener: ((event: unknown) => void) | undefined;
		let output = "";
		const outputStream = new Writable({
			write(chunk, _encoding, callback) {
				output += chunk.toString();
				callback();
			},
		});
		const inputStream = Readable.from(["help me\n", "/quit\n"]);
		const readline = createInterface({ input: inputStream, output: outputStream });
		const runtime = {} as ModelRuntime;
		const agent = {
			session: {
				model: { provider: "openai", id: "gpt-test" },
				modelRuntime: runtime,
				subscribe(callback: (event: unknown) => void) {
					listener = callback;
					return () => {};
				},
				async prompt() {
					listener?.({
						type: "message_end",
						message: {
							role: "assistant",
							stopReason: "error",
							errorMessage: "Account has no credits remaining.",
						},
					});
					listener?.({ type: "agent_end", messages: [], willRetry: false });
				},
			},
			dispose() {},
			setActiveTools() {},
		} as unknown as LearningAgentSession;

		await runRepl({
			workflow: new WorkflowController(createLearningSession("/tmp/project")),
			agent,
			modelRuntime: runtime,
			inputReader: readline,
			input: inputStream,
			output: outputStream,
		});
		readline.close();

		expect(output).toContain("The model provider could not complete that request.");
		expect(output).toContain("Account has no credits remaining.");
	});
});
