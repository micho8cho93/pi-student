import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PolicyProvider } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { SupabaseGovernancePolicyProvider } from "../src/governance-policy.js";

const context = { identity: { kind: "student" as const, userId: "u" }, projectId: "p" };
const standalone: PolicyProvider = { resolvePolicy: async () => ({ projectId: "p", version: 1, settings: DEFAULT_CAPABILITY_POLICY }) };
const profileId = "75000000-0000-0000-0000-000000000001";
function client(managed: boolean, denied = false): SupabaseClient {
	return {
		auth: { getSession: async () => ({ data: { session: { access_token: "student-jwt" } }, error: null }) },
		from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { class_id: "c", classes: { organization_id: managed ? "o" : null } }, error: null }) }) }) }),
		rpc: async (name: string) => denied ? { data: null, error: new Error("access denied") } : name === "governance_context" ? {
			data: { organizationId: "o", classId: "c", project: { version: 1, settings: DEFAULT_CAPABILITY_POLICY },
				layers: [{ scope: "organization", version: 2, settings: { internet: false }, delegatedPaths: ["models"] }] }, error: null,
		} : { data: [{ id: profileId, organization_id: "o", display_name: "Approved", provider: "openai", provider_model: "approved", allowed_thinking_levels: ["off"], available: true, fallback_profile_id: null, version: 1 }], error: null },
	} as unknown as SupabaseClient;
}

it("resolves managed restrictions and approved models before the runtime", async () => {
	const configure = vi.fn();
	const result = await new SupabaseGovernancePolicyProvider(client(true), standalone, { url: "https://models.example.test", configure }).resolvePolicy(context);
	expect(result?.settings.internet).toBe(false);
	expect(result?.settings.models).toEqual([`institution/${profileId}`]);
	expect(result?.provenance?.internet.scope).toBe("organization");
	expect(configure).toHaveBeenCalledWith("p", "https://models.example.test", expect.arrayContaining([expect.objectContaining({ id: profileId })]), "student-jwt");
});

it("does not substitute a local policy when managed authorization fails", async () => {
	await expect(new SupabaseGovernancePolicyProvider(client(true, true), standalone).resolvePolicy(context)).rejects.toThrow("access denied");
	expect((await new SupabaseGovernancePolicyProvider(client(false), standalone).resolvePolicy(context))?.settings.models).toEqual([]);
});
