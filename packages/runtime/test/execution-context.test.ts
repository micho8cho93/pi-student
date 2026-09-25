import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExecutionContext } from "../src/execution-context.js";
import { createStudentRuntime } from "../src/student-runtime.js";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
	const workspacePath = await mkdtemp(path.join(os.tmpdir(), "pi-execution-context-"));
	roots.push(workspacePath);
	const selection = { workspacePath, projectId: "project-a", classId: "class-a", organizationId: "org-a" };
	const scope = { projectId: "project-a", classId: "class-a", organizationId: "org-a", userId: "student-a" };
	const policy = { projectId: "project-a", version: 1, sourceVersions: { organization: 1 }, settings: { ...DEFAULT_CAPABILITY_POLICY, models: ["openai/small"] } };
	const sources = { workspacePath, selection,
		identityProvider: { getIdentity: async () => ({ kind: "student" as const, userId: "student-a" }) },
		scopeProvider: { resolve: vi.fn(async () => scope) },
		policyProvider: { resolvePolicy: vi.fn(async () => policy) },
		environmentProvider: { resolve: vi.fn(async () => ({ sandbox: { mode: "gondolin" as const }, skills: [], mcps: [] })) } };
	return sources;
}

describe("authoritative execution context", () => {
	it("binds the authenticated student, class, organization, workspace, policy, and sandbox", async () => {
		const sources = await fixture();
		const context = await resolveExecutionContext(sources);
		expect(context).toMatchObject({ workspacePath: await realpath(sources.workspacePath), projectId: "project-a", classId: "class-a", organizationId: "org-a",
			identity: { userId: "student-a", projectId: "project-a" }, sandbox: { mode: "gondolin" } });
	});
	it("rejects a selected project from another workspace before contacting Supabase", async () => {
		const sources = await fixture();
		const other = await mkdtemp(path.join(os.tmpdir(), "pi-other-workspace-")); roots.push(other);
		await expect(resolveExecutionContext({ ...sources, workspacePath: other })).rejects.toThrow("another workspace");
		expect(sources.scopeProvider.resolve).not.toHaveBeenCalled();
	});
	it.each([
		["project", { projectId: "project-b" }], ["class", { classId: "class-b" }],
		["organization", { organizationId: "org-b" }], ["user", { userId: "student-b" }],
	])("rejects %s scope mismatch", async (_label, change) => {
		const sources = await fixture();
		sources.scopeProvider.resolve.mockResolvedValue({ projectId: "project-a", classId: "class-a", organizationId: "org-a", userId: "student-a", ...change });
		await expect(resolveExecutionContext(sources)).rejects.toThrow("does not match");
		expect(sources.environmentProvider.resolve).not.toHaveBeenCalled();
	});
	it("rejects stale policy, provider failure, and cross-tenant extensions", async () => {
		const sources = await fixture();
		await expect(resolveExecutionContext({ ...sources, selection: { ...sources.selection,
			policy: { projectId: "project-b", version: 1, settings: DEFAULT_CAPABILITY_POLICY } } })).rejects.toThrow("Stored policy");
		sources.policyProvider.resolvePolicy.mockResolvedValueOnce({ projectId: "project-b", version: 1, sourceVersions: { organization: 1 }, settings: DEFAULT_CAPABILITY_POLICY });
		await expect(resolveExecutionContext(sources)).rejects.toThrow("policy");
		sources.scopeProvider.resolve.mockRejectedValueOnce(new Error("offline"));
		await expect(resolveExecutionContext(sources)).rejects.toThrow("offline");
		sources.environmentProvider.resolve.mockResolvedValueOnce({ sandbox: { mode: "gondolin" }, skills: [{ id: "x", name: "foreign", organizationId: "org-b" }], mcps: [] });
		await expect(resolveExecutionContext(sources)).rejects.toThrow("another organization");
	});
	it("rejects a resumed session from another workspace", async () => {
		const sources = await fixture();
		const other = await mkdtemp(path.join(os.tmpdir(), "pi-other-session-")); roots.push(other);
		const runtime = createStudentRuntime({ projectPath: sources.workspacePath, modelProvider: {} as never,
			sandboxProvider: { create: () => ({ mode: "gondolin", isRunning: () => false, start: async () => {}, stop: async () => {}, getWorkspacePath: () => "/workspace" }) as never },
			identityProvider: sources.identityProvider, policyProvider: sources.policyProvider });
		await expect(runtime.bindSession({ getCwd: () => other, getSessionId: () => "session-a" })).rejects.toThrow("another workspace");
		await runtime.bindSession({ getCwd: () => sources.workspacePath, getSessionId: () => "session-a" });
		expect((await runtime.executionContext({})).sessionId).toBe("session-a");
	});
});
