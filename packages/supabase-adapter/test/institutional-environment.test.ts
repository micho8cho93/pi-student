import { describe, expect, it } from "vitest";
import { SupabaseInstitutionalEnvironmentProvider, validateProfile } from "../src/institutional-environment.js";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { EffectivePolicy, SandboxProfile } from "@pi-student/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

const org = "org-1";
const base: SandboxProfile = {
	id: "profile-1", organizationId: org, name: "Python", version: 2, runtime: "python", runtimeVersion: "3.12",
	packages: [{ name: "numpy", version: "2.1.0", integrity: `sha256:${"a".repeat(64)}` }],
	imageDigest: `sha256:${"b".repeat(64)}`, buildStatus: "ready", datasets: [],
	network: { allowed: false, allowedHosts: [] },
	limits: { cpuMillis: 1000, memoryMiB: 1024, storageMiB: 2048, timeoutSeconds: 120 }, metadata: {},
};

function client(payload: unknown, managed = true): SupabaseClient {
	return {
		from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { classes: { organization_id: managed ? org : null } }, error: null }) }) }) }),
		rpc: async () => ({ data: payload, error: null }),
	} as unknown as SupabaseClient;
}

describe("institutional environment resolution", () => {
	it("leaves standalone classrooms on the existing sandbox path", async () => {
		expect(await new SupabaseInstitutionalEnvironmentProvider(client(null, false)).resolve("project-1")).toBeUndefined();
	});
	it("filters disabled/capability-restricted extensions before runtime configuration", async () => {
		const policy: EffectivePolicy = { projectId: "project-1", version: 1, settings: { ...DEFAULT_CAPABILITY_POLICY, internet: false } };
		const payload = { organizationId: org, projectId: "project-1", blockedSites: ["youtube.com"], profile: base,
			skills: [{ id: "read", name: "Read", organizationId: org, capabilities: [] }, { id: "net", name: "Net", organizationId: org, capabilities: ["network"] }],
			mcps: [{ id: "mcp", name: "MCP", transport: "http", organizationId: org, capabilities: ["secrets"] }] };
		const result = await new SupabaseInstitutionalEnvironmentProvider(client(payload)).resolve("project-1", policy);
		expect(result?.sandbox.profile).toEqual(base);
		expect(result?.sandbox.internetAllowed).toBe(false);
		expect(result?.sandbox.blockedHosts).toEqual(["youtube.com"]);
		expect(result?.skills?.map(skill => skill.id)).toEqual(["read"]);
		expect(result?.mcps).toEqual([]);
	});
	it("rejects malformed blocked sites from the control plane", async () => {
		const payload = { organizationId: org, projectId: "project-1", blockedSites: ["https://example.com/path"], profile: null, skills: [], mcps: [] };
		await expect(new SupabaseInstitutionalEnvironmentProvider(client(payload)).resolve("project-1")).rejects.toThrow("blocked sites");
	});
	it("rejects tenant mismatch and invalid guest mount paths", () => {
		expect(() => validateProfile({ ...base, organizationId: "other" }, org)).toThrow();
		expect(() => validateProfile({ ...base, datasets: [{ id: "d", organizationId: org, name: "Secret", version: "1", sizeBytes: 1,
			artifactId: "abcdefghijklmnop", sha256: "f".repeat(64), scope: "organization", mountPath: "/datasets/../private", access: "read-only" }] }, org)).toThrow();
		expect(() => validateProfile({ ...base, packages: [{ name: "numpy", version: "latest", integrity: "" }] }, org)).toThrow();
	});
	it("rejects a failed or unverified image", () => {
		expect(() => validateProfile({ ...base, buildStatus: "failed" as "ready" }, org)).toThrow();
		expect(() => validateProfile({ ...base, imageDigest: "not-pinned" }, org)).toThrow();
	});
});
