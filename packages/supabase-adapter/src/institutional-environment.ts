import type { EffectivePolicy, McpDescriptor, McpProvider, SandboxCapability, SandboxConfig, SandboxEnvironmentStatus, SandboxProfile, SkillDescriptor, SkillProvider } from "@pi-student/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface InstitutionalEnvironment {
	sandbox: SandboxConfig;
	skills: SkillDescriptor[];
	mcps: McpDescriptor[];
	status: SandboxEnvironmentStatus;
	requiredCapabilities: readonly SandboxCapability[];
}

const digest = /^sha256:[a-f0-9]{64}$/;
const mount = /^\/datasets\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/;
const capabilities = new Set(["filesystem", "network", "shell", "github", "database", "external_api", "secrets"]);

/** Membership and scope are checked in the RPC. A failure is never a local fallback. */
export class SupabaseInstitutionalEnvironmentProvider {
	constructor(private readonly client: SupabaseClient) {}

	async resolve(projectId: string, policy?: EffectivePolicy): Promise<InstitutionalEnvironment | undefined> {
		const { data: project, error: lookupError } = await this.client.from("projects")
			.select("class_id,classes(organization_id)").eq("id", projectId).maybeSingle();
		if (lookupError) throw lookupError;
		if (!project) throw new Error("Project access is unavailable.");
		const classRow = project.classes as unknown as { organization_id: string | null } | Array<{ organization_id: string | null }> | null;
		const projectClass = Array.isArray(classRow) ? classRow[0] : classRow;
		if (!projectClass || (projectClass.organization_id !== null && typeof projectClass.organization_id !== "string")) {
			throw new Error("Project class scope is unavailable.");
		}
		if (!projectClass.organization_id) return undefined;
		const { data, error } = await this.client.rpc("resolve_institutional_environment", { project_id_input: projectId });
		if (error) throw error;
		if (!data || typeof data !== "object" || !data.organizationId || data.projectId !== projectId || data.classId !== project.class_id ||
			data.organizationId !== projectClass.organization_id) {
			throw new Error("Institutional environment authorization is unavailable.");
		}
		const profile = data.profile as SandboxProfile | null;
		if (profile) validateProfile(profile, String(data.organizationId));
		const blockedHosts = validateBlockedHosts(data.blockedSites);
		const status = environmentStatus(data.environmentStatus ?? (profile ? profile.buildStatus : "configured"));
		const requiredCapabilities = [...new Set([
			...validateRequiredCapabilities(data.requiredCapabilities, profile),
			"workspace" as const,
			...(blockedHosts.length ? ["blocked-hosts" as const] : []),
			...(policy?.settings.internet !== undefined ? ["internet-policy" as const] : []),
		])];
		const allowed = (requested: unknown): boolean => {
			if (!Array.isArray(requested) || !requested.every(value => typeof value === "string" && capabilities.has(value))) return false;
			// Explicit organization approval is necessary, but cannot override student policy.
			if (!policy) return requested.length === 0;
			return requested.every(value => {
				switch (value) {
					case "filesystem": return policy.settings.fileEditing;
					case "shell": return policy.settings.terminal;
					case "network": case "github": case "database": case "external_api": return policy.settings.internet;
					case "secrets": return false; // Host-side MCP broker only; never the student process.
					default: return false;
				}
			});
		};
		const scoped = <T extends { id: string; organizationId?: string; classId?: string; projectId?: string; scope?: string; capabilities?: string[]; enabled?: boolean; approvalStatus?: string; allowedHosts?: readonly string[]; secretReference?: string }>(rows: unknown): T[] => {
			if (!Array.isArray(rows)) throw new Error("Invalid institutional extension inventory.");
			if (rows.some(row => !row || typeof row !== "object" || typeof row.id !== "string" || !row.id || row.organizationId !== data.organizationId)) {
				throw new Error("Institutional extension belongs to another organization.");
			}
			return rows.flatMap(sqlRow => {
				// jsonb_build_object emits SQL NULL columns as JSON null; the contract models them as absent.
				const row = Object.fromEntries(Object.entries(sqlRow).filter(([key, value]) =>
					!(value === null && ["classId", "projectId", "description"].includes(key)))) as typeof sqlRow;
				if (row.enabled !== true || row.approvalStatus !== "approved") return [];
				if (!validExtensionScope(row, String(data.classId), projectId)) throw new Error("Institutional extension scope is invalid.");
				if ("allowedHosts" in row && (!Array.isArray(row.allowedHosts) || !row.allowedHosts.every((host: unknown) => typeof host === "string" && validHost(host)))) throw new Error("Invalid institutional connector hosts.");
				if (!allowed(row.capabilities)) return [];
				const { secretReference: _secretReference, ...safe } = row;
				return [safe as T];
			});
		};
		return {
			sandbox: {
				mode: "gondolin",
				internetAllowed: (policy?.settings.internet ?? true) && (profile?.network.allowed ?? true),
				blockedHosts,
				...(profile ? { profile } : {}),
			},
			skills: scoped<SkillDescriptor>(data.skills),
			mcps: scoped<McpDescriptor>(data.mcps),
			status,
			requiredCapabilities,
		};
	}
}

function validExtensionScope(row: { scope?: string; classId?: string; projectId?: string }, classId: string, projectId: string): boolean {
	if (row.scope === "organization") return row.classId === undefined && row.projectId === undefined;
	if (row.scope === "class") return row.classId === classId && row.projectId === undefined;
	if (row.scope === "project") return row.classId === classId && row.projectId === projectId;
	return false;
}

function validHost(value: string): boolean {
	return value.length <= 253 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value);
}

function validateBlockedHosts(value: unknown): string[] {
	const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
	const hostname = new RegExp(`^${label}(?:\\.${label})+$`);
	if (!Array.isArray(value) || value.length > 500 || !value.every(host =>
		typeof host === "string" && host === host.toLowerCase() && host.length <= 253 && hostname.test(host))) {
		throw new Error("Invalid institutional sandbox blocked sites.");
	}
	return [...new Set(value)];
}

/** Existing provider contracts expose the already-admitted inventory, not an executor. */
export class InstitutionalSkillProvider implements SkillProvider {
	constructor(private readonly environment: SupabaseInstitutionalEnvironmentProvider,
		private readonly projectId: string, private readonly policy?: EffectivePolicy) {}
	async listSkills(): Promise<SkillDescriptor[]> {
		return (await this.environment.resolve(this.projectId, this.policy))?.skills ?? [];
	}
}

export class InstitutionalMcpProvider implements McpProvider {
	constructor(private readonly environment: SupabaseInstitutionalEnvironmentProvider,
		private readonly projectId: string, private readonly policy?: EffectivePolicy) {}
	async listMcps(): Promise<McpDescriptor[]> {
		return (await this.environment.resolve(this.projectId, this.policy))?.mcps ?? [];
	}
}

export function validateProfile(profile: SandboxProfile, organizationId: string): void {
	if (profile.organizationId !== organizationId || !["pending", "building", "ready", "failed"].includes(profile.buildStatus) || !digest.test(profile.imageDigest) ||
		!Number.isSafeInteger(profile.version) || profile.version < 1 || !["generic", "python", "node"].includes(profile.runtime) ||
		!Array.isArray(profile.packages) || !Array.isArray(profile.datasets) || !profile.network || !profile.limits ||
		!Array.isArray(profile.network.allowedHosts) || !profile.network.allowedHosts.every(host => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host))) {
		throw new Error("Invalid institutional sandbox profile.");
	}
	if (profile.packages.some(pkg => !/^[a-zA-Z0-9@/_-]{1,120}$/.test(pkg.name) || !/^[0-9][a-zA-Z0-9._+-]{0,79}$/.test(pkg.version) || !digest.test(pkg.integrity))) throw new Error("Unpinned sandbox package.");
	for (const dataset of profile.datasets) {
		if (dataset.organizationId !== organizationId || !mount.test(dataset.mountPath) ||
			! /^[a-zA-Z0-9_-]{16,128}$/.test(dataset.artifactId) || !/^[a-f0-9]{64}$/.test(dataset.sha256) ||
			!Number.isSafeInteger(dataset.sizeBytes) || dataset.sizeBytes < 0 || !["read-only", "read-write"].includes(dataset.access)) {
			throw new Error("Invalid dataset mount or artifact.");
		}
	}
	if (new Set(profile.datasets.map(dataset => dataset.mountPath)).size !== profile.datasets.length) throw new Error("Duplicate dataset mount.");
}

function environmentStatus(value: unknown): SandboxEnvironmentStatus {
	if (value === "configured" || value === "unsupported" || value === "pending" || value === "building" || value === "ready" || value === "failed") return value;
	if (value === "active") throw new Error("Institutional environment active state must be established by the local runtime.");
	throw new Error("Invalid institutional environment status.");
}

function validateRequiredCapabilities(value: unknown, profile: SandboxProfile | null): SandboxCapability[] {
	const allowed = new Set<SandboxCapability>(["workspace", "internet-policy", "blocked-hosts", "managed-profile", "profile-image", "datasets", "resource-limits"]);
	if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== "string" || !allowed.has(item as SandboxCapability)))) {
		throw new Error("Invalid institutional environment capabilities.");
	}
	if (Array.isArray(value)) return [...new Set(value as SandboxCapability[])];
	if (!profile) return ["workspace"];
	const required: SandboxCapability[] = ["workspace", "managed-profile", "profile-image", "resource-limits"];
	if (profile.datasets.length) required.push("datasets");
	return [...new Set(required)];
}
