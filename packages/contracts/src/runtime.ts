import type { IdentityContext } from "./identity.js";
import type { ModelDescriptor } from "./models.js";
import type { EffectivePolicy } from "./policy.js";
import type { SandboxConfig } from "./sandbox.js";

export interface RuntimeConfiguration {
	identity: IdentityContext;
	policy?: EffectivePolicy;
	model?: ModelDescriptor;
	sandbox: SandboxConfig;
}

export interface SkillDescriptor {
	id: string;
	name: string;
	description?: string;
}

export interface SkillProvider {
	listSkills(): Promise<SkillDescriptor[]>;
}

export interface McpDescriptor {
	id: string;
	name: string;
	transport: "stdio" | "http";
}

export interface McpProvider {
	listMcps(): Promise<McpDescriptor[]>;
}
