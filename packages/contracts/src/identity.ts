/** Identifier contracts shared across classroom, telemetry, and runtime DTOs. */
export type UserId = string;
export type OrganizationId = string;
export type ClassId = string;
export type ProjectId = string;
export type SessionId = string;
export type RequirementId = string;
export type StandardId = string;

export type ClassRole = "teacher" | "student";
export type MembershipStatus = "pending" | "active" | "rejected";

/** Runtime identity without coupling domain packages to an auth vendor. */
export type IdentityKind = "anonymous" | "personal" | "student" | "teacher";

export interface IdentityContext {
	kind: IdentityKind;
	userId?: UserId;
	/** Reserved tenancy correlation; absent for today's personal and classroom sessions. */
	organizationId?: OrganizationId;
	displayName?: string;
	email?: string;
	classId?: ClassId;
	projectId?: ProjectId;
}

export interface IdentityProvider {
	getIdentity(): Promise<IdentityContext>;
}
