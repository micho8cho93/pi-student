import type { ProjectId } from "./identity.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type LearningStage = "understand" | "plan" | "implement" | "review" | "verify" | "reflect";

export interface CapabilityPolicy {
	schemaVersion: 1;
	reasoningLevels: ThinkingLevel[];
	models: string[];
	fileEditing: boolean;
	terminal: boolean;
	dependencyInstallation: boolean;
	internet: boolean;
	desktopExport: boolean;
	imageUploads: boolean;
	fileUploads: boolean;
	reflection: boolean;
	limits: { minutes: number | null; turns: number | null; tokens: number | null; cost: number | null };
	accessibility: { dictation: boolean; cloudDictation: boolean; readAloud: boolean; simplifiedVocabulary: boolean; readableFormatting: boolean };
}

export interface EffectivePolicy {
	projectId: ProjectId;
	version: number;
	settings: CapabilityPolicy;
}

export interface PolicyContext {
	identity: import("./identity.js").IdentityContext;
	projectId?: ProjectId;
	sessionId?: string;
}

/** Resolves the policy in force for a runtime invocation. */
export interface PolicyProvider {
	resolvePolicy(context: PolicyContext): Promise<EffectivePolicy | undefined>;
}
