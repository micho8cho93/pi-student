import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LearningAgentSession } from "@pi-student/runtime/create-session";
import { runRepl } from "../src/terminal/repl.js";
import { createLearningSession } from "@pi-student/education/types";
import { WorkflowController } from "@pi-student/education/workflow-controller";

describe("plain terminal fallback", () => {
	it("keeps streamed work notes and tool activity in chronological order", async () => {
		let listener: ((event: any) => void) | undefined;
		let output = "";
		const outputStream = new Writable({
			write(chunk, _encoding, callback) {
				output += chunk.toString();
				callback();
			},
		});
		const inputStream = Readable.from(["make the change\n", "/quit\n"]);
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
					listener?.({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_start" } });
					listener?.({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "The failing test points to the parser." } });
					listener?.({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_end" } });
					listener?.({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "edit", args: { path: "src/parser.ts" } });
					listener?.({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "edit", result: {}, isError: false });
					listener?.({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_start" } });
					listener?.({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "The parser is fixed." } });
					listener?.({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
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

		const workNote = output.indexOf("The failing test points to the parser.");
		const toolStart = output.indexOf("using edit");
		const toolEnd = output.indexOf("edit finished");
		const finalAnswer = output.indexOf("The parser is fixed.");
		expect(output).toContain("Work notes · reasoning");
		expect(workNote).toBeLessThan(toolStart);
		expect(toolStart).toBeLessThan(toolEnd);
		expect(toolEnd).toBeLessThan(finalAnswer);
	});

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

	it("announces controller stage changes so the terminal indicator never goes stale", async () => {
		let output = "";
		const outputStream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
		const inputStream = Readable.from(["what next\n", "/quit\n"]);
		const readline = createInterface({ input: inputStream, output: outputStream });
		const workflow = new WorkflowController(createLearningSession("/tmp/project"));
		const agent = {
			session: {
				model: { provider: "openai", id: "gpt-test" },
				modelRuntime: {} as ModelRuntime,
				subscribe() { return () => {}; },
				async prompt() {
					workflow.updateLearningState({ currentStage: "understand", readyForNextStage: true, goalSummary: "Add a counter", understandingReady: true, reason: "clear" });
				},
			},
			dispose() {},
			setActiveTools() {},
		} as unknown as LearningAgentSession;

		await runRepl({ workflow, agent, modelRuntime: {} as ModelRuntime, inputReader: readline, input: inputStream, output: outputStream });
		readline.close();

		expect(workflow.getStage()).toBe("plan");
		expect(output).toContain("ROUTING · UNDERSTAND");
		expect(output).toContain("learning · PLAN");
		expect(output.indexOf("ROUTING · UNDERSTAND")).toBeLessThan(output.indexOf("learning · PLAN"));
	});
});
