import type { IdentityContext } from "./identity.js";
import type { ModelDescriptor } from "./models.js";
import type { EffectivePolicy } from "./policy.js";
import type { ExtensionCapability, ExtensionScope, SandboxConfig } from "./sandbox.js";

export interface RuntimeConfiguration {
	identity: IdentityContext;
	policy?: EffectivePolicy;
	model?: ModelDescriptor;
	sandbox: SandboxConfig;
	skills?: SkillDescriptor[];
	mcps?: McpDescriptor[];
}

export interface SkillDescriptor {
	id: string;
	name: string;
	description?: string;
	organizationId?: string;
	version?: string;
	scope?: ExtensionScope;
	capabilities?: ExtensionCapability[];
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
	version?: string;
	scope?: ExtensionScope;
	capabilities?: ExtensionCapability[];
	endpoint?: string;
	/** Opaque host-managed handle. Never a credential value. */
	secretReference?: string;
}

export interface McpProvider {
	listMcps(): Promise<McpDescriptor[]>;
}
