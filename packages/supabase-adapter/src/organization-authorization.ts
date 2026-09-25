import type { SupabaseClient } from "@supabase/supabase-js";
import { membershipCan, type OrganizationAccess, type OrganizationAdministration, type OrganizationAuthorization, type OrganizationCapability, type OrganizationMembership, type OrganizationMembershipStatus, type OrganizationNonOwnerRole, type OrganizationRole } from "@pi-student/organization";

/** Postgres RLS is authoritative; this adapter never supplies a trusted user ID. */
export class SupabaseOrganizationAuthorization implements OrganizationAuthorization, OrganizationAdministration {
	constructor(readonly client: SupabaseClient) {}

	async getMembership(organizationId: string): Promise<OrganizationMembership | undefined> {
		const userId = await this.requireUserId();
		const { data, error } = await this.client.from("organization_memberships")
			.select("organization_id,user_id,role,status")
			.eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
		if (error) throw error;
		return data ? mapMembership(data) : undefined;
	}

	async listOrganizationsForUser(): Promise<OrganizationAccess[]> {
		const userId = await this.requireUserId();
		const { data, error } = await this.client.from("organization_memberships")
			.select("organization_id,user_id,role,status,organizations(id,slug,name)")
			.eq("user_id", userId).eq("status", "active");
		if (error) throw error;
		return (data ?? []).flatMap(row => {
			const raw = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
			if (!raw) return [];
			return [{ organization: { id: String(raw.id), slug: String(raw.slug), name: String(raw.name) }, membership: mapMembership(row) }];
		});
	}

	async can(organizationId: string, capability: OrganizationCapability): Promise<boolean> {
		return membershipCan(await this.getMembership(organizationId), capability);
	}

	async createOrganization(slug: string, name: string): Promise<string> {
		const { data, error } = await this.client.rpc("create_organization", { slug_input: slug, name_input: name });
		if (error) throw error;
		return String(data);
	}

	async setMembership(organizationId: string, userId: string, role: OrganizationNonOwnerRole, status: OrganizationMembershipStatus): Promise<void> {
		const { error } = await this.client.rpc("set_organization_membership", {
			organization_id_input: organizationId, user_id_input: userId, role_input: role, status_input: status,
		});
		if (error) throw error;
	}

	async transferOwnership(organizationId: string, targetUserId: string): Promise<void> {
		const { error } = await this.client.rpc("transfer_organization_ownership", {
			organization_id_input: organizationId, target_user_id_input: targetUserId,
		});
		if (error) throw error;
	}

	async removeMembership(organizationId: string, userId: string): Promise<void> {
		const { error } = await this.client.rpc("remove_organization_membership", {
			organization_id_input: organizationId, user_id_input: userId,
		});
		if (error) throw error;
	}

	async setClassTeacherAssignments(classId: string, teacherIds: string[]): Promise<void> {
		const { error } = await this.client.rpc("set_class_teacher_assignments", {
			class_id_input: classId, teacher_ids_input: teacherIds,
		});
		if (error) throw error;
	}

	private async requireUserId(): Promise<string> {
		const { data, error } = await this.client.auth.getUser();
		if (error || !data.user) throw error ?? new Error("Sign in before accessing organizations.");
		return data.user.id;
	}
}

function mapMembership(row: { organization_id: unknown; user_id: unknown; role: unknown; status: unknown }): OrganizationMembership {
	return {
		organizationId: String(row.organization_id), userId: String(row.user_id),
		role: row.role as OrganizationRole, status: row.status as OrganizationMembershipStatus,
	};
}
