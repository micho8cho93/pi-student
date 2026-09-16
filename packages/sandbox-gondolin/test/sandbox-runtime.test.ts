import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostRuntime } from "@pi-student/sandbox-gondolin/host-runtime";
import { createSandboxGrepTool, createSandboxToolDefinitions, readSandboxMode } from "@pi-student/sandbox/sandbox-manager";
import { SANDBOX_ENV_ALLOWLIST } from "@pi-student/sandbox-gondolin/gondolin-runtime";
import { SANDBOX_WORKSPACE, type SandboxRuntime } from "@pi-student/sandbox/types";

describe("sandbox runtime boundary", () => {
	it("maps the host development runtime to /workspace", async () => {
		const project = await mkdtemp(path.join(os.tmpdir(), "pi-student-sandbox-"));
		const runtime = new HostRuntime();
		try {
			await runtime.start(project);
			await runtime.writeFile("/workspace/src/example.ts", "export const answer = 42;\n");
			expect(await runtime.readFile("src/example.ts")).toContain("answer = 42");
			const writeTool = createSandboxToolDefinitions(runtime).find((tool) => tool.name === "write");
			await writeTool?.execute("write-test", { path: "src/adapter.ts", content: "export const adapted = true;\n" }, undefined, undefined, {} as never);
			expect(await runtime.readFile("/workspace/src/adapter.ts")).toContain("adapted = true");
			expect((await runtime.listFiles()).map((file) => file.replaceAll("\\", "/"))).toContain("/workspace/src/example.ts");
			expect((await runtime.exec("pwd", { cwd: SANDBOX_WORKSPACE })).exitCode).toBe(0);
			await expect(runtime.readFile("/etc/passwd")).rejects.toThrow(/outside/);
		} finally {
			await runtime.stop();
			await rm(project, { recursive: true, force: true });
		}
	});

	it("keeps provider credentials out of the Gondolin environment allowlist", () => {
		expect(SANDBOX_ENV_ALLOWLIST.has("OPENAI_API_KEY")).toBe(false);
		expect(SANDBOX_ENV_ALLOWLIST.has("ANTHROPIC_API_KEY")).toBe(false);
		expect(SANDBOX_ENV_ALLOWLIST.has("GEMINI_API_KEY")).toBe(false);
		expect(SANDBOX_ENV_ALLOWLIST.has("NODE_ENV")).toBe(true);
	});

	it("defaults unknown or invalid sandbox modes to Gondolin", () => {
		expect(readSandboxMode({ SANDBOX_MODE: "gondolin" })).toBe("gondolin");
		expect(readSandboxMode({ SANDBOX_MODE: "unexpected" })).toBe("gondolin");
		expect(readSandboxMode({ SANDBOX_MODE: "host" })).toBe("host");
	});

	it("registers all project tools through runtime-backed adapters", () => {
		const runtime = fakeRuntime();
		const tools = createSandboxToolDefinitions(runtime);
		const names = tools.map((tool) => tool.name);
		names.push(createSandboxGrepTool(runtime).name);
		expect(names).toEqual(["read", "write", "edit", "bash", "ls", "find", "grep"]);
		expect(tools.find((tool) => tool.name === "bash")?.promptSnippet).toMatch(/shell|command/i);
	});
});

function fakeRuntime(): SandboxRuntime {
	return {
		start: async () => undefined,
		stop: async () => undefined,
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		readFile: async () => "",
		writeFile: async () => undefined,
		mkdir: async () => undefined,
		fileExists: async () => true,
		listFiles: async () => [],
		listDirectory: async () => [],
		getWorkspacePath: () => SANDBOX_WORKSPACE,
		isRunning: () => true,
	};
}
