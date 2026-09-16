import type { ThinkingLevel } from "@pi-student/contracts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
export type { ThinkingLevel } from "@pi-student/contracts";

export interface ThinkingModelCapabilities {
	reasoning: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/**
 * Normalize a persisted/requested level before a model switch. Pi performs a
 * similar clamp internally, but keeping this helper at the application edge
 * prevents a fallback model from inheriting an impossible provider setting.
 */
export function resolveThinkingLevel(model: ThinkingModelCapabilities, requested: ThinkingLevel): ThinkingLevel {
	const available = supportedThinkingLevels(model);
	if (available.includes(requested)) return requested;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	for (let index = requestedIndex; index < THINKING_LEVELS.length; index += 1) {
		if (available.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
	}
	for (let index = requestedIndex - 1; index >= 0; index -= 1) {
		if (available.includes(THINKING_LEVELS[index])) return THINKING_LEVELS[index];
	}
	return "off";
}

export function supportedThinkingLevels(model: ThinkingModelCapabilities): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		return level !== "xhigh" && level !== "max" || mapped !== undefined;
	});
}
