import type { OrganizationId, UserId } from "@pi-student/contracts";
export * from "./model-governance.js";
export * from "./usage.js";

/** These are tenant roles, independent of classroom teacher/student roles. */
export type OrganizationRole = "owner" | "admin" | "teacher" | "member";
export type OrganizationMembershipStatus = "active" | "suspended";
/** Assigned only by a trusted platform service, never by classroom membership. */
export type PlatformRole = "platform_admin";
export type OrganizationCapability = "view" | "manage" | "manage_members" | "create_class";

export interface Organization {
	id: OrganizationId;
	slug: string;
	name: string;
}

export interface OrganizationMembership {
	organizationId: OrganizationId;
	userId: UserId;
	role: OrganizationRole;
	status: OrganizationMembershipStatus;
}

export interface OrganizationAccess {
	organization: Organization;
	membership: OrganizationMembership;
}

/** Control-plane seam. The implementation must check the authenticated subject. */
export interface OrganizationAuthorization {
	getMembership(organizationId: OrganizationId): Promise<OrganizationMembership | undefined>;
	listOrganizationsForUser(): Promise<OrganizationAccess[]>;
	can(organizationId: OrganizationId, capability: OrganizationCapability): Promise<boolean>;
}

/** Commands are separate from the student runtime's read-only authorization seam. */
export interface OrganizationAdministration {
	createOrganization(slug: string, name: string): Promise<OrganizationId>;
	setMembership(organizationId: OrganizationId, userId: UserId, role: OrganizationRole, status: OrganizationMembershipStatus): Promise<void>;
	removeMembership(organizationId: OrganizationId, userId: UserId): Promise<void>;
}

/** A product grant is independent of a user's authorization within a tenant. */
export type OrganizationEntitlementKey =
	| "organization_admin" | "model_governance" | "usage_dashboard" | "budget_controls"
	| "custom_skills" | "custom_mcps" | "sandbox_profiles" | "lms_integrations"
	| "advanced_exports" | "private_model_endpoint" | "enterprise_sso";

export interface OrganizationEntitlements {
	has(organizationId: OrganizationId, capability: OrganizationEntitlementKey): Promise<boolean>;
}

/** Both checks are required; a product grant never supplies a user role. */
export async function canUseOrganizationFeature(
	authorization: OrganizationAuthorization,
	entitlements: OrganizationEntitlements,
	organizationId: OrganizationId,
	action: OrganizationCapability,
	capability: OrganizationEntitlementKey,
): Promise<boolean> {
	if (!await authorization.can(organizationId, action)) return false;
	return entitlements.has(organizationId, capability);
}

const capabilities: Record<OrganizationRole, ReadonlySet<OrganizationCapability>> = {
	owner: new Set(["view", "manage", "manage_members", "create_class"]),
	admin: new Set(["view", "manage", "manage_members", "create_class"]),
	teacher: new Set(["view", "create_class"]),
	member: new Set(["view"]),
};

/** Tenant capabilities do not grant access to any particular class. */
export function membershipCan(membership: OrganizationMembership | undefined, capability: OrganizationCapability): boolean {
	return membership?.status === "active" && capabilities[membership.role].has(capability);
}
