import { THINKING_LEVELS, supportedThinkingLevels, type ThinkingLevel, type ThinkingModelCapabilities } from "../pi/thinking.js";

/** Project settings only. Accessibility never grants editing or tool permissions. */
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

export interface EffectivePolicy { projectId: string; version: number; settings: CapabilityPolicy }
export const DEFAULT_CAPABILITY_POLICY: CapabilityPolicy = {
	schemaVersion: 1, reasoningLevels: [...THINKING_LEVELS], models: [],
	fileEditing: true, terminal: true, dependencyInstallation: true, internet: true,
	desktopExport: true, imageUploads: true, fileUploads: true, reflection: true,
	limits: { minutes: null, turns: null, tokens: null, cost: null },
	accessibility: { dictation: true, cloudDictation: true, readAloud: false, simplifiedVocabulary: false, readableFormatting: false },
};

export const CAPABILITY_FIELDS = [
	["fileEditing", "File editing", "Allow Pi to create and change project files."],
	["terminal", "Terminal commands", "Allow Pi to run sandbox commands."],
	["dependencyInstallation", "Dependency installation", "Allow package installation. When off, shell access is limited to inspection to prevent installation through scripts."],
	["internet", "Internet access", "Allow outbound web requests from the project sandbox."],
	["desktopExport", "Desktop export", "Allow confirmed exports to the student's Desktop."],
	["imageUploads", "Image uploads", "Allow images in student messages."],
	["fileUploads", "File uploads", "Allow file attachments in student messages."],
	["reflection", "Learning reflection", "Include the existing reflection step and end-of-session reflection invitation."],
] as const;
export const ACCESSIBILITY_FIELDS = [
	["dictation", "Dictation", "Allow speech to text input."],
	["cloudDictation", "Cloud transcription", "Allow remote transcription providers; turn off for on-device transcription only."],
	["readAloud", "Read aloud", "Allow /read-aloud to speak the latest answer using an installed system voice."],
	["simplifiedVocabulary", "Simplified vocabulary", "Explain technical terms using familiar words."],
	["readableFormatting", "Readable formatting", "Use short paragraphs, clear spacing, and short steps."],
] as const;

export function parseCapabilityPolicy(value: unknown): CapabilityPolicy {
	if (value == null) return structuredClone(DEFAULT_CAPABILITY_POLICY);
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project capability settings.");
	const raw = value as Record<string, unknown>;
	const policy = structuredClone(DEFAULT_CAPABILITY_POLICY);
	if (raw.schemaVersion !== 1) throw new Error("Unsupported project policy version. Update Pi Student.");
	if (!Array.isArray(raw.reasoningLevels) || !raw.reasoningLevels.length || raw.reasoningLevels.some(x => !THINKING_LEVELS.includes(x))) throw new Error("Choose at least one valid reasoning level.");
	policy.reasoningLevels = THINKING_LEVELS.filter(x => (raw.reasoningLevels as unknown[]).includes(x));
	if (!Array.isArray(raw.models) || raw.models.length > 30 || raw.models.some(x => typeof x !== "string" || !/^[^\s/]+\/[^\s]+$/.test(x) || x.length > 200)) throw new Error("Use provider/model IDs for approved models, one per line.");
	policy.models = [...new Set(raw.models as string[])];
	for (const [key] of CAPABILITY_FIELDS) {
		if (typeof raw[key] !== "boolean") throw new Error(`Invalid ${key} setting.`);
		policy[key] = raw[key];
	}
	const accessibility = raw.accessibility as Record<string, unknown> | undefined;
	for (const [key] of ACCESSIBILITY_FIELDS) {
		if (typeof accessibility?.[key] !== "boolean") throw new Error(`Invalid accessibility setting: ${key}.`);
		policy.accessibility[key] = accessibility[key];
	}
	const limits = raw.limits as Record<string, unknown> | undefined;
	for (const key of ["minutes", "turns", "tokens", "cost"] as const) {
		const limit = limits?.[key];
		if (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0 || limit > 1e9 || (key !== "cost" && !Number.isInteger(limit)))) throw new Error(`Invalid ${key} limit. Leave blank for unlimited.`);
		policy.limits[key] = limit as number | null;
	}
	return policy;
}

export function allowedReasoningLevels(policy: CapabilityPolicy, model: ThinkingModelCapabilities): ThinkingLevel[] {
	return supportedThinkingLevels(model).filter(level => policy.reasoningLevels.includes(level));
}
export function modelAllowed(policy: CapabilityPolicy, model: { provider: string; id: string } & ThinkingModelCapabilities): boolean {
	return (!policy.models.length || policy.models.includes(`${model.provider}/${model.id}`)) && allowedReasoningLevels(policy, model).length > 0;
}
