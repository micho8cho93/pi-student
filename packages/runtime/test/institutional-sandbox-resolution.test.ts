import { expect, it, vi } from "vitest";
import { createStudentRuntime, type CreateStudentRuntimeOptions } from "../src/student-runtime.js";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

it("passes one control-plane resolution to the sandbox when an assignment changes", async () => {
	const projectPath = await mkdtemp(path.join(os.tmpdir(), "pi-sandbox-resolution-"));
	try {
	let running = false;
	const configure = vi.fn(async () => { running = false; });
	const sandbox: SandboxRuntime = {
		mode: "gondolin", configure, start: async () => { running = true; }, stop: async () => { running = false; },
		getCapabilities: () => ({ provider: "test-gondolin", mode: "gondolin", capabilities: ["workspace", "internet-policy", "blocked-hosts"] }),
		isRunning: () => running, getWorkspacePath: () => "/workspace", exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		readFile: async () => "", writeFile: async () => {}, fileExists: async () => false, listFiles: async () => [],
	};
	const resolve = vi.fn(async () => ({ sandbox: { mode: "gondolin" as const, internetAllowed: false },
		skills: [{ id: "approved", name: "Approved", organizationId: "organization", capabilities: [] }], mcps: [] }));
	let selection: { projectId?: string; classId?: string; organizationId?: string; workspacePath?: string } = {};
	const runtime = createStudentRuntime({
		projectPath, sandboxProvider: { create: () => sandbox },
		contextStore: { read: async () => selection, write: async next => { selection = next; } },
		modelProvider: {} as CreateStudentRuntimeOptions["modelProvider"],
		identityProvider: { getIdentity: async () => ({ kind: "student", userId: "student" }) },
		scopeProvider: { resolve: async () => ({ projectId: "project", classId: "class", organizationId: "organization", userId: "student" }) },
		policyProvider: { resolvePolicy: async () => ({ projectId: "project", version: 1, sourceVersions: { organization: 1 }, settings: DEFAULT_CAPABILITY_POLICY }) },
		environmentProvider: { resolve },
	});
	await runtime.start();
	selection = { projectId: "project", classId: "class", organizationId: "organization", workspacePath: projectPath };
	await runtime.selectEnvironment(selection);
	expect(resolve).toHaveBeenCalledOnce();
	expect(configure).toHaveBeenLastCalledWith({ mode: "gondolin", internetAllowed: false });
	expect((await runtime.configuration()).skills?.map(skill => skill.id)).toEqual(["approved"]);
	expect(sandbox.isRunning()).toBe(true);
	await runtime.dispose();
	} finally { await rm(projectPath, { recursive: true, force: true }); }
});

it("converges a running session on revoked network policy and on an environment that stops being ready", async () => {
	const projectPath = await mkdtemp(path.join(os.tmpdir(), "pi-sandbox-reconcile-"));
	try {
	let running = false;
	const configure = vi.fn(async () => { running = false; });
	const sandbox: SandboxRuntime = {
		mode: "gondolin", configure, start: async () => { running = true; }, stop: async () => { running = false; },
		getCapabilities: () => ({ provider: "test-gondolin", mode: "gondolin", capabilities: ["workspace", "internet-policy", "blocked-hosts"] }),
		isRunning: () => running, getWorkspacePath: () => "/workspace", exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		readFile: async () => "", writeFile: async () => {}, fileExists: async () => false, listFiles: async () => [],
	};
	let control: { blockedHosts: string[]; status: "configured" | "pending" } = { blockedHosts: [], status: "configured" };
	const selection = { projectId: "project", classId: "class", organizationId: "organization", workspacePath: projectPath };
	const runtime = createStudentRuntime({
		projectPath, sandboxProvider: { create: () => sandbox },
		contextStore: { read: async () => selection, write: async () => {} },
		modelProvider: {} as CreateStudentRuntimeOptions["modelProvider"],
		identityProvider: { getIdentity: async () => ({ kind: "student", userId: "student" }) },
		scopeProvider: { resolve: async () => ({ projectId: "project", classId: "class", organizationId: "organization", userId: "student" }) },
		policyProvider: { resolvePolicy: async () => ({ projectId: "project", version: 1, sourceVersions: { organization: 1 }, settings: DEFAULT_CAPABILITY_POLICY }) },
		environmentProvider: { resolve: async () => ({ sandbox: { mode: "gondolin" as const, internetAllowed: true, blockedHosts: control.blockedHosts },
			status: control.status, skills: [], mcps: [] }) },
	});
	await runtime.start();
	const reconcile = runtime.services.reconcileEnvironment!;
	await reconcile(await runtime.executionContext());
	expect(configure).toHaveBeenCalledTimes(1);

	control = { blockedHosts: ["example.org"], status: "configured" };
	await reconcile(await runtime.executionContext());
	expect(configure).toHaveBeenLastCalledWith({ mode: "gondolin", internetAllowed: true, blockedHosts: ["example.org"] });
	expect(sandbox.isRunning()).toBe(true);

	control = { blockedHosts: ["example.org"], status: "pending" };
	const context = await runtime.executionContext();
	expect(context.environment?.status).toBe("pending");
	await expect(reconcile(context)).rejects.toThrow("still being prepared");
	await runtime.dispose();
	} finally { await rm(projectPath, { recursive: true, force: true }); }
});
