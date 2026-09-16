import type { ModelProfile, ThinkingLevel } from "@pi-student/contracts";

export function resolveApprovedModel(profiles: readonly ModelProfile[], requestedId: string, allowedIds: readonly string[], thinking: ThinkingLevel): ModelProfile {
	const byId = new Map(profiles.map(profile => [profile.id, profile]));
	const requested = byId.get(requestedId);
	if (!requested || !allowedIds.includes(requested.id)) throw new Error("Model profile is not approved.");
	if (requested.available && requested.allowedThinkingLevels.includes(thinking)) return requested;
	const fallback = requested.fallbackProfileId && byId.get(requested.fallbackProfileId);
	if (!fallback || fallback.organizationId !== requested.organizationId || !fallback.available || !allowedIds.includes(fallback.id) || !fallback.allowedThinkingLevels.includes(thinking)) {
		throw new Error("No approved model is available for this thinking level.");
	}
	return fallback;
}
