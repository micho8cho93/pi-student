import { describe, expect, it } from "vitest";
import { parseStudentRuntimeArgs, splitModelId } from "@pi-student/runtime/runtime-args";

describe("shared runtime arguments", () => {
	it("accepts the Pi RPC options Paseo supplies", () => {
		expect(parseStudentRuntimeArgs([
			"--mode", "rpc",
			"--model=openai/gpt-5",
			"--thinking", "high",
			"--session", "/tmp/student.jsonl",
			"--extension", "/tmp/paseo-extension.js",
		])).toEqual({
			mode: "rpc",
			model: "openai/gpt-5",
			thinking: "high",
			session: "/tmp/student.jsonl",
			noSession: false,
		});
	});

	it("rejects modes and persistence combinations outside the contract", () => {
		expect(() => parseStudentRuntimeArgs(["--mode", "json"])).toThrow(/only supports --mode rpc/);
		expect(() => parseStudentRuntimeArgs(["--session", "one", "--no-session"])).toThrow(/cannot be used together/);
		expect(() => parseStudentRuntimeArgs(["--mystery"])).toThrow(/unsupported/i);
	});

	it("preserves provider-qualified model IDs", () => {
		expect(splitModelId("openrouter/anthropic/claude")).toEqual({ provider: "openrouter", modelId: "anthropic/claude" });
		expect(() => splitModelId("missing-provider")).toThrow(/provider\/model/);
	});
});
