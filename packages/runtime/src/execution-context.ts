import { realpath } from "node:fs/promises";
import type { ExecutionContext, ExecutionScopeProvider, IdentityProvider, PolicyProvider, RuntimeConfiguration, SandboxEnvironmentState } from "@pi-student/contracts";
import type { TeacherContext } from "@pi-student/telemetry/types";
import { readSandboxMode } from "@pi-student/sandbox/sandbox-manager";

export interface ExecutionContextSources {
	workspacePath: string;
	sessionId?: string;
	selection: TeacherContext;
	identityProvider: IdentityProvider;
	policyProvider: PolicyProvider;
	scopeProvider?: ExecutionScopeProvider;
	environmentProvider?: { resolve(projectId: string, policy?: RuntimeConfiguration["policy"]): Promise<Pick<RuntimeConfiguration, "sandbox" | "skills" | "mcps" | "environment"> & { status?: SandboxEnvironmentState["status"]; requiredCapabilities?: SandboxEnvironmentState["requiredCapabilities"] } | undefined> };
}

export async function resolveExecutionContext(sources: ExecutionContextSources): Promise<ExecutionContext> {
	const { selection } = sources;
	if (!selection || typeof selection !== "object" || Array.isArray(selection) ||
		[selection.projectId, selection.classId, selection.organizationId, selection.workspacePath]
			.some(value => value !== undefined && (typeof value !== "string" || !value.trim()))) {
		throw new Error("Stored classroom selection is invalid. Select the project again.");
	}
	const workspacePath = await realpath(sources.workspacePath);
	const identity = await sources.identityProvider.getIdentity();
	if (!selection.projectId) {
		if (selection.organizationId || selection.policy || selection.workspacePath) throw new Error("Classroom selection is incomplete. Select a project again.");
		return { identity, workspacePath, sessionId: sources.sessionId, sandbox: { mode: readSandboxMode() }, classId: selection.classId };
	}
	if (selection.policy && selection.policy.projectId !== selection.projectId) {
		throw new Error("Stored policy belongs to another project. Select the project again.");
	}
	if (!selection.workspacePath || await realpath(selection.workspacePath).catch(() => undefined) !== workspacePath) {
		throw new Error("The selected class project belongs to another workspace. Run pi-student project select <project-id> from this workspace before continuing.");
	}
	if (!identity.userId || identity.kind !== "student" || !sources.scopeProvider) {
		throw new Error("A signed-in student and project authorization are required.");
	}
	const scope = await sources.scopeProvider.resolve(selection.projectId);
	if (scope.projectId !== selection.projectId || scope.userId !== identity.userId || scope.classId !== selection.classId ||
		(scope.organizationId ?? undefined) !== (selection.organizationId ?? undefined)) {
		throw new Error("Selected project, class, organization, or user does not match the authorized scope.");
	}
	const policy = await sources.policyProvider.resolvePolicy({ identity, projectId: scope.projectId });
	if (!policy || policy.projectId !== scope.projectId) throw new Error("Project policy is unavailable or belongs to another project.");
	const environment = await sources.environmentProvider?.resolve(scope.projectId, policy);
	if (scope.organizationId && (!environment || !policy.sourceVersions?.organization)) {
		throw new Error("Institutional policy or environment is unavailable.");
	}
	for (const extension of [...(environment?.skills ?? []), ...(environment?.mcps ?? [])]) {
		if (scope.organizationId && extension.organizationId !== scope.organizationId) throw new Error("Extension belongs to another organization.");
	}
	if (environment?.sandbox.profile?.organizationId && environment.sandbox.profile.organizationId !== scope.organizationId) {
		throw new Error("Sandbox profile belongs to another organization.");
	}
	const environmentState: SandboxEnvironmentState | undefined = environment ? {
		status: environment.environment?.status ?? environment.status ?? "configured",
		provider: environment.environment?.provider ?? "gondolin",
		capabilities: environment.environment?.capabilities ?? { provider: "gondolin", mode: environment.sandbox.mode, capabilities: [] },
		requiredCapabilities: environment.environment?.requiredCapabilities ?? environment.requiredCapabilities ?? [],
	} : undefined;
	return { identity: { ...identity, classId: scope.classId, projectId: scope.projectId,
		...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
		workspacePath, sessionId: sources.sessionId, projectId: scope.projectId, classId: scope.classId, organizationId: scope.organizationId,
		policy, sandbox: environment?.sandbox ?? { mode: readSandboxMode() }, environment: environmentState,
		skills: environment?.skills ?? [], mcps: environment?.mcps ?? [] };
}
