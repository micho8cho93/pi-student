import { expect, it, vi } from "vitest";
import { createStudentRuntime, type CreateStudentRuntimeOptions } from "../src/student-runtime.js";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { SandboxRuntime } from "@pi-student/sandbox/types";

it("passes one control-plane resolution to the sandbox when an assignment changes", async () => {
	let running = false;
	const configure = vi.fn(async () => { running = false; });
	const sandbox: SandboxRuntime = {
		mode: "gondolin", configure, start: async () => { running = true; }, stop: async () => { running = false; },
		isRunning: () => running, getWorkspacePath: () => "/workspace", exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		readFile: async () => "", writeFile: async () => {}, fileExists: async () => false, listFiles: async () => [],
	};
	const resolve = vi.fn(async () => ({ sandbox: { mode: "gondolin" as const, internetAllowed: false },
		skills: [{ id: "approved", name: "Approved", capabilities: [] }], mcps: [] }));
	const runtime = createStudentRuntime({
		projectPath: "/workspace", sandboxProvider: { create: () => sandbox },
		modelProvider: {} as CreateStudentRuntimeOptions["modelProvider"],
		identityProvider: { getIdentity: async () => ({ kind: "student", userId: "student" }) },
		policyProvider: { resolvePolicy: async () => ({ projectId: "project", version: 1, settings: DEFAULT_CAPABILITY_POLICY }) },
		environmentProvider: { resolve },
	});
	await runtime.start();
	await runtime.selectEnvironment("project");
	expect(resolve).toHaveBeenCalledOnce();
	expect(configure).toHaveBeenLastCalledWith({ mode: "gondolin", internetAllowed: false });
	expect((await runtime.configuration()).skills?.map(skill => skill.id)).toEqual(["approved"]);
	expect(sandbox.isRunning()).toBe(true);
	await runtime.dispose();
});
