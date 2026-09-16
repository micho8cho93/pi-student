import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrganizationEntitlementKey, OrganizationEntitlements } from "@pi-student/organization";

/** The database resolver verifies the current subject before returning a grant. */
export class SupabaseOrganizationEntitlements implements OrganizationEntitlements {
	constructor(private readonly client: SupabaseClient) {}

	async has(organizationId: string, capability: OrganizationEntitlementKey): Promise<boolean> {
		const { data, error } = await this.client.rpc("organization_has_entitlement", {
			organization_id_input: organizationId, capability_input: capability,
		});
		if (error) throw error;
		return data === true;
	}
}
