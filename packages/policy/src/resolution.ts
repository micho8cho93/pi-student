import type { CapabilityPolicy, EffectivePolicy, ThinkingLevel } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "./capability-policy.js";

export type PolicyScope = "platform" | "organization" | "class" | "project" | "session";
type Limits = CapabilityPolicy["limits"];
type Accessibility = CapabilityPolicy["accessibility"];
export type PolicyPatch = Partial<Omit<CapabilityPolicy, "schemaVersion" | "limits" | "accessibility">> & {
	limits?: Partial<Limits>;
	accessibility?: Partial<Accessibility>;
};
export interface PolicyLayer {
	scope: PolicyScope;
	version: number;
	settings: PolicyPatch;
}
export interface PolicyResolutionInput {
	projectId: string;
	/** Only these paths may be changed at class, project, or session level. */
	delegatedPaths: readonly string[];
	organization?: PolicyLayer;
	class?: PolicyLayer;
	project?: PolicyLayer;
	session?: PolicyLayer;
	platform?: PolicyLayer;
	resolvedAt?: string;
}

const booleanPaths = ["fileEditing", "terminal", "dependencyInstallation", "internet", "desktopExport", "imageUploads", "fileUploads", "reflection",
	"accessibility.dictation", "accessibility.cloudDictation", "accessibility.readAloud", "accessibility.simplifiedVocabulary", "accessibility.readableFormatting"] as const;
const limitPaths = ["limits.minutes", "limits.turns", "limits.tokens", "limits.cost"] as const;
const arrayPaths = ["models", "reasoningLevels"] as const;
const allPaths = [...booleanPaths, ...limitPaths, ...arrayPaths];

function read(source: Record<string, unknown>, path: string): unknown {
	return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, source);
}
function write(target: Record<string, unknown>, path: string, value: unknown): void {
	const [first, second] = path.split(".");
	if (second) (target[first] as Record<string, unknown>)[second] = value;
	else target[first] = value;
}

/** Fail-closed merge: omissions inherit; false, smaller caps, and narrower lists remain restrictive. */
export function resolveEffectivePolicy(input: PolicyResolutionInput): EffectivePolicy {
	const settings = structuredClone(DEFAULT_CAPABILITY_POLICY);
	const provenance: NonNullable<EffectivePolicy["provenance"]> = {};
	const layers: PolicyLayer[] = [input.platform ?? { scope: "platform", version: 1, settings: {} },
		input.organization, input.class, input.project, input.session].filter((layer): layer is PolicyLayer => Boolean(layer));
	for (const path of allPaths) provenance[path] = { scope: "platform", version: layers[0]!.version, reason: "default" };
	const sourceVersions: NonNullable<EffectivePolicy["sourceVersions"]> = {};
	for (const layer of layers) {
		if (!Number.isSafeInteger(layer.version) || layer.version < 1) throw new Error("Invalid policy version.");
		sourceVersions[layer.scope] = layer.version;
		for (const path of allPaths) {
			const proposed = read(layer.settings as Record<string, unknown>, path);
			if (proposed === undefined) continue;
			if (["class", "project", "session"].includes(layer.scope) && !input.delegatedPaths.includes(path)) {
				throw new Error(`${layer.scope} cannot configure ${path}.`);
			}
			const current = read(settings as unknown as Record<string, unknown>, path);
			let next: unknown;
			let reason = "selected";
			if (booleanPaths.includes(path as typeof booleanPaths[number])) {
				if (typeof proposed !== "boolean") throw new Error(`Invalid ${path}.`);
				next = Boolean(current) && proposed;
				if (proposed && !current) continue;
				if (!proposed) reason = "disabled";
			} else if (limitPaths.includes(path as typeof limitPaths[number])) {
				if (proposed !== null && (typeof proposed !== "number" || !Number.isFinite(proposed) || proposed <= 0 || proposed > 1e9 ||
					(path !== "limits.cost" && !Number.isInteger(proposed)))) throw new Error(`Invalid ${path}.`);
				if (proposed === null) continue;
				next = current === null ? proposed : Math.min(current as number, proposed);
				if (next !== proposed) continue;
				reason = "capped";
			} else {
				if (!Array.isArray(proposed) || !proposed.length || proposed.some(value => typeof value !== "string") || new Set(proposed).size !== proposed.length) throw new Error(`Invalid ${path}.`);
				if (path === "reasoningLevels" && proposed.some(value => !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value))) throw new Error("Invalid reasoning level.");
				if (path === "models" && proposed.some(value => !/^[^\s/]+\/[^\s]+$/.test(value))) throw new Error("Invalid model ID.");
				next = path === "models" && !(current as string[]).length ? [...proposed] : (current as string[]).filter(value => proposed.includes(value));
				if (!(next as string[]).length) throw new Error(`Policy leaves no allowed ${path}.`);
				reason = "restricted";
			}
			write(settings as unknown as Record<string, unknown>, path, next);
			provenance[path] = { scope: layer.scope, version: layer.version, reason };
		}
	}
	return { projectId: input.projectId, version: 1, settings, provenance, sourceVersions, resolvedAt: input.resolvedAt ?? new Date().toISOString() };
}
