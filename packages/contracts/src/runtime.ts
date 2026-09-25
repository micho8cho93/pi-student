import type { IdentityContext } from "./identity.js";
import type { ModelDescriptor } from "./models.js";
import type { EffectivePolicy } from "./policy.js";
import type { ExtensionCapability, ExtensionScope, SandboxConfig, SandboxEnvironmentState } from "./sandbox.js";

export interface RuntimeConfiguration {
	identity: IdentityContext;
	policy?: EffectivePolicy;
	model?: ModelDescriptor;
	sandbox: SandboxConfig;
	environment?: SandboxEnvironmentState;
	skills?: SkillDescriptor[];
	mcps?: McpDescriptor[];
}

/** Validated before a model, sandbox, or school extension can run. */
export interface ExecutionContext extends RuntimeConfiguration {
	workspacePath: string;
	sessionId?: string;
	projectId?: string;
	classId?: string;
	organizationId?: string;
}

export interface ExecutionScope {
	projectId: string;
	classId: string;
	organizationId?: string;
	userId: string;
}

export interface ExecutionScopeProvider {
	resolve(projectId: string): Promise<ExecutionScope>;
}

export interface SkillDescriptor {
	id: string;
	name: string;
	description?: string;
	organizationId?: string;
	classId?: string;
	projectId?: string;
	version?: string;
	scope?: ExtensionScope;
	capabilities?: ExtensionCapability[];
	enabled?: boolean;
	approvalStatus?: "pending" | "approved" | "rejected";
	allowedWorkflowStages?: readonly string[];
	/** Registration is metadata only; only signed, reviewed sandbox artifacts can execute. */
	artifactDigest?: string;
}

export interface SkillProvider {
	listSkills(): Promise<SkillDescriptor[]>;
}

export interface McpDescriptor {
	id: string;
	name: string;
	transport: "stdio" | "http";
	organizationId?: string;
	classId?: string;
	projectId?: string;
	version?: string;
	scope?: ExtensionScope;
	capabilities?: ExtensionCapability[];
	enabled?: boolean;
	approvalStatus?: "pending" | "approved" | "rejected";
	allowedWorkflowStages?: readonly string[];
	allowedHosts?: readonly string[];
	endpoint?: string;
	/** Opaque host-managed handle. Never a credential value. */
	secretReference?: string;
}

export interface McpProvider {
	listMcps(): Promise<McpDescriptor[]>;
}
