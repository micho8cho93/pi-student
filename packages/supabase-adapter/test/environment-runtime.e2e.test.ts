import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createGondolinHttpHooks } from "@pi-student/sandbox-gondolin/gondolin-runtime";
import { GondolinRuntime } from "@pi-student/sandbox-gondolin/gondolin-runtime";
import { GondolinSandboxProvider } from "@pi-student/sandbox-gondolin/provider";
import { createStudentRuntime } from "@pi-student/runtime/student-runtime";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { SupabaseInstitutionalEnvironmentProvider } from "../src/institutional-environment.js";

const organizationId = "org-e2e";
const classId = "class-e2e";
const projectId = "project-e2e";

function controlPlaneClient(payload: unknown): SupabaseClient {
	return {
		from: () => ({
			select: () => ({
				eq: () => ({ maybeSingle: async () => ({ data: { class_id: classId, classes: { organization_id: organizationId } }, error: null }) }),
			}),
		}),
		rpc: vi.fn(async () => ({ data: payload, error: null })),
	} as unknown as SupabaseClient;
}

it("resolves the persisted environment through Supabase, launches the Gondolin provider, enforces restrictions, and reports active state", async () => {
	const projectPath = await mkdtemp(path.join(os.tmpdir(), "pi-environment-e2e-"));
	try {
		const environmentProvider = new SupabaseInstitutionalEnvironmentProvider(controlPlaneClient({
			organizationId, classId, projectId, environmentStatus: "configured",
			requiredCapabilities: ["workspace", "internet-policy", "blocked-hosts"],
			blockedSites: ["example.org"], profile: null, skills: [], mcps: [],
		}));
		const sandbox = new GondolinRuntime();
		let running = false;
		const configure = vi.spyOn(sandbox, "configure");
		const start = vi.spyOn(sandbox, "start").mockImplementation(async () => { running = true; });
		vi.spyOn(sandbox, "stop").mockImplementation(async () => { running = false; });
		vi.spyOn(sandbox, "isRunning").mockImplementation(() => running);
		const sandboxProvider = new GondolinSandboxProvider();
		vi.spyOn(sandboxProvider, "create").mockReturnValue(sandbox);
		const selection = { projectId, classId, organizationId, workspacePath: projectPath };
		const runtime = createStudentRuntime({
			projectPath,
			modelProvider: {} as never,
			sandboxProvider,
			contextStore: { read: async () => selection, write: async () => {} },
			identityProvider: { getIdentity: async () => ({ kind: "student" as const, userId: "student-e2e" }) },
			scopeProvider: { resolve: async () => ({ projectId, classId, organizationId, userId: "student-e2e" }) },
			policyProvider: { resolvePolicy: async () => ({ projectId, version: 1, sourceVersions: { organization: 1 }, settings: DEFAULT_CAPABILITY_POLICY }) },
			environmentProvider,
		});

		await runtime.start();
		const state = (await runtime.executionContext()).environment;
		expect(configure).toHaveBeenCalledWith({ mode: "gondolin", internetAllowed: true, blockedHosts: ["example.org"] });
		expect(start).toHaveBeenCalledWith(projectPath);
		expect(state).toMatchObject({ status: "active", provider: "gondolin", requiredCapabilities: ["workspace", "internet-policy", "blocked-hosts"] });

		const { httpHooks } = createGondolinHttpHooks({ isInternetAllowed: () => true, blockedHosts: () => ["example.org"] });
		expect(await httpHooks.isRequestAllowed!(new Request("https://sub.example.org:8443/redirect"))).toBe(false);
		expect(await httpHooks.isRequestAllowed!(new Request("https://school.example/"))).toBe(true);
		expect(await httpHooks.isIpAllowed!({ hostname: "school.example", ip: "127.0.0.1", family: 4, port: 443, protocol: "https" })).toBe(false);
		expect(await httpHooks.isIpAllowed!({ hostname: "school.example", ip: "93.184.216.34", family: 4, port: 443, protocol: "https" })).toBe(true);
		await runtime.dispose();
	} finally {
		await rm(projectPath, { recursive: true, force: true });
	}
});
