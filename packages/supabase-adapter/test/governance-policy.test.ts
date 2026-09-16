import { expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PolicyProvider } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { SupabaseGovernancePolicyProvider } from "../src/governance-policy.js";

const context = { identity: { kind: "student" as const, userId: "u" }, projectId: "p" };
const standalone: PolicyProvider = { resolvePolicy: async () => ({ projectId: "p", version: 1, settings: DEFAULT_CAPABILITY_POLICY }) };
function client(managed: boolean, denied = false): SupabaseClient {
	return {
		from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { class_id: "c", classes: { organization_id: managed ? "o" : null } }, error: null }) }) }) }),
		rpc: async (name: string) => denied ? { data: null, error: new Error("access denied") } : name === "governance_context" ? {
			data: { organizationId: "o", classId: "c", project: { version: 1, settings: DEFAULT_CAPABILITY_POLICY },
				layers: [{ scope: "organization", version: 2, settings: { internet: false }, delegatedPaths: ["models"] }] }, error: null,
		} : { data: [{ provider: "openai", provider_model: "approved" }], error: null },
	} as unknown as SupabaseClient;
}

it("resolves managed restrictions and approved models before the runtime", async () => {
	const result = await new SupabaseGovernancePolicyProvider(client(true), standalone).resolvePolicy(context);
	expect(result?.settings.internet).toBe(false);
	expect(result?.settings.models).toEqual(["openai/approved"]);
	expect(result?.provenance?.internet.scope).toBe("organization");
});

it("does not substitute a local policy when managed authorization fails", async () => {
	await expect(new SupabaseGovernancePolicyProvider(client(true, true), standalone).resolvePolicy(context)).rejects.toThrow("access denied");
	expect((await new SupabaseGovernancePolicyProvider(client(false), standalone).resolvePolicy(context))?.settings.models).toEqual([]);
});
