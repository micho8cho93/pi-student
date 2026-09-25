import type { ExecutionContext, ExtensionCapability, McpDescriptor, SkillDescriptor } from "@pi-student/contracts";

export type AuthorizedExtension = SkillDescriptor | McpDescriptor;
export type ExtensionKind = "skill" | "mcp";

export interface ExtensionCatalogEntry {
	id: string;
	endpoint?: string;
	hosts?: readonly string[];
	capabilities?: readonly string[];
}

export interface ExtensionAuthorization {
	allowed: boolean;
	reasonCode: string;
	capability?: ExtensionCapability;
}

/**
 * Validates the resolved sandbox contract at a model/tool execution boundary.
 * Standalone classrooms have no institutional environment and keep their
 * existing local sandbox path; organization-backed projects must have a
 * ready, capability-compatible environment.
 */
export function assertExecutionEnvironment(context: ExecutionContext): void {
	if (!context.organizationId) return;
	if (!context.identity.userId || context.identity.kind !== "student" || !context.classId || !context.projectId) {
		throw new Error("A valid institutional execution context is required.");
	}
	const environment = context.environment;
	if (!environment || !["configured", "ready", "active"].includes(environment.status)) {
		throw new Error("The institutional sandbox is not ready for this project.");
	}
	if (environment.capabilities.mode !== context.sandbox.mode) {
		throw new Error("The institutional sandbox mode does not match the authorized environment.");
	}
	if (environment.requiredCapabilities.some(required => !environment.capabilities.capabilities.includes(required))) {
		throw new Error("The institutional sandbox cannot provide the required capabilities.");
	}
}

const knownCapabilities = new Set<ExtensionCapability>([
	"filesystem", "network", "shell", "github", "database", "external_api", "secrets",
]);

/**
 * Revalidates the control-plane snapshot immediately before an extension call.
 * Discovery uses the same predicate, but callers must invoke this again at the
 * execution boundary because Supabase state may have changed since discovery.
 */
export function authorizeExtension(
	context: ExecutionContext | undefined,
	extension: AuthorizedExtension,
	kind: ExtensionKind,
	action: "list" | "read" | "call",
	stage: string | undefined,
	catalog?: ExtensionCatalogEntry,
): ExtensionAuthorization {
	if (!context || context.identity.kind !== "student" || !context.identity.userId) return deny("execution-context-required");
	if (!context.organizationId || !context.classId || !context.projectId) return deny("managed-project-required");
	if (context.identity.organizationId !== context.organizationId || context.identity.classId !== context.classId || context.identity.projectId !== context.projectId) {
		return deny("execution-context-mismatch");
	}
	if (!context.environment) return deny("environment-required");
	if (!["configured", "ready", "active"].includes(context.environment.status)) return deny("environment-not-ready");
	if (context.environment.requiredCapabilities.some(required => !context.environment!.capabilities.capabilities.includes(required))) {
		return deny("sandbox-capability-missing");
	}
	if (extension.enabled !== true || extension.approvalStatus !== "approved") return deny("extension-not-approved");
	if (extension.organizationId !== context.organizationId) return deny("organization-mismatch");
	if (extension.scope === "organization") {
		if (extension.classId !== undefined || extension.projectId !== undefined) return deny("scope-invalid");
	} else if (extension.scope === "class") {
		if (extension.classId !== context.classId || extension.projectId !== undefined) return deny("class-scope-mismatch");
	} else if (extension.scope === "project") {
		if (extension.classId !== context.classId || extension.projectId !== context.projectId) return deny("project-scope-mismatch");
	} else {
		return deny("scope-missing");
	}
	if (extension.allowedWorkflowStages && (!stage || !extension.allowedWorkflowStages.includes(stage))) return deny("workflow-stage-denied");
	for (const capability of extension.capabilities ?? []) {
		if (!knownCapabilities.has(capability)) return deny("capability-unknown", capability);
		if (!capabilityAllowed(context, capability)) return deny("capability-denied", capability);
	}
	if (kind === "mcp") {
		const mcp = extension as McpDescriptor;
		if (action === "call" && !["implement", "verify"].includes(stage ?? "")) return deny("workflow-stage-denied");
		if (!catalog || !catalog.endpoint || mcp.endpoint !== catalog.endpoint) return deny("connector-not-curated");
		const endpointHost = safeHostname(catalog.endpoint);
		const hosts = new Set((mcp.allowedHosts ?? []).map((host: string) => host.toLowerCase().replace(/\.$/u, "")));
		if (!endpointHost || !hosts.has(endpointHost)) return deny("host-not-allowlisted");
		if (catalog.hosts?.some(host => !hosts.has(host.toLowerCase().replace(/\.$/u, "")))) return deny("host-not-allowlisted");
	}
	return { allowed: true, reasonCode: "authorized" };
}

export function availableExtensionNames(context: ExecutionContext | undefined, stage?: string, catalogs: { skills: readonly ExtensionCatalogEntry[]; mcps: readonly ExtensionCatalogEntry[] } = { skills: [], mcps: [] }): string[] {
	const names: string[] = [];
	if (context?.skills?.some(skill => authorizeExtension(context, skill, "skill", "list", stage).allowed)) names.push("school_skill");
	if (context?.mcps?.some(mcp => authorizeExtension(context, mcp, "mcp", "list", stage, catalogs.mcps.find(item => item.endpoint === mcp.endpoint)).allowed)) names.push("school_mcp");
	return names;
}

function capabilityAllowed(context: ExecutionContext, capability: ExtensionCapability): boolean {
	if (capability === "secrets") return false;
	const settings = context.policy?.settings;
	if (capability === "filesystem") return settings?.fileEditing === true;
	if (capability === "shell") return settings?.terminal === true;
	if (["network", "github", "database", "external_api"].includes(capability)) {
		return settings?.internet === true && context.sandbox.internetAllowed !== false && context.environment?.capabilities.capabilities.includes("internet-policy") === true;
	}
	return false;
}

function safeHostname(endpoint: string): string | undefined {
	try {
		const url = new URL(endpoint);
		if (url.protocol !== "https:") return undefined;
		return url.hostname.toLowerCase().replace(/\.$/u, "");
	} catch {
		return undefined;
	}
}

function deny(reasonCode: string, capability?: ExtensionCapability): ExtensionAuthorization {
	return { allowed: false, reasonCode, ...(capability ? { capability } : {}) };
}
