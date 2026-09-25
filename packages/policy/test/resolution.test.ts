import { describe, expect, it } from "vitest";
import { resolveEffectivePolicy } from "../src/resolution.js";

const delegatedPaths = ["internet", "models", "limits.tokens", "reasoningLevels", "accessibility.readAloud"];

describe("hierarchical effective policy", () => {
	it("inherits omissions, preserves higher denies, and records provenance", () => {
		const resolved = resolveEffectivePolicy({ projectId: "p", delegatedPaths,
			platform: { scope: "platform", version: 3, settings: { internet: false, limits: { tokens: 100_000 } } },
			organization: { scope: "organization", version: 4, settings: { internet: true, limits: { tokens: 50_000 }, models: ["openai/fast", "openai/advanced"] } },
			class: { scope: "class", version: 2, settings: { models: ["openai/advanced"] } },
			project: { scope: "project", version: 6, settings: { internet: true, limits: { tokens: 75_000 } } },
		});
		expect(resolved.settings.internet).toBe(false);
		expect(resolved.provenance?.internet).toEqual({ scope: "platform", version: 3, reason: "disabled" });
		expect(resolved.settings.limits.tokens).toBe(50_000);
		expect(resolved.provenance?.["limits.tokens"]).toEqual({ scope: "organization", version: 4, reason: "capped" });
		expect(resolved.settings.models).toEqual(["openai/advanced"]);
		expect(resolved.provenance?.models.scope).toBe("class");
	});
	it("lets a teacher narrow a delegated tutoring reserve but not widen the agent limit", () => {
		const resolved = resolveEffectivePolicy({ projectId: "p", delegatedPaths: ["limits.tutoringTurns"],
			organization: { scope: "organization", version: 1, settings: { limits: { turns: 20, tutoringTurns: 10 } } },
			class: { scope: "class", version: 1, settings: { limits: { tutoringTurns: 4 } } } });
		expect(resolved.settings.limits).toMatchObject({ turns: 20, tutoringTurns: 4 });
		expect(resolved.provenance?.["limits.tutoringTurns"]).toMatchObject({ scope: "class", reason: "capped" });
		expect(() => resolveEffectivePolicy({ projectId: "p", delegatedPaths: ["limits.tutoringTurns"],
			class: { scope: "class", version: 1, settings: { limits: { turns: 50 } } } })).toThrow(/cannot configure limits.turns/);
	});
	it("rejects undelegated teacher settings and empty model intersections", () => {
		expect(() => resolveEffectivePolicy({ projectId: "p", delegatedPaths: [], class: { scope: "class", version: 1, settings: { internet: false } } })).toThrow(/cannot configure internet/);
		expect(() => resolveEffectivePolicy({ projectId: "p", delegatedPaths, organization: { scope: "organization", version: 1, settings: { models: ["a/one"] } },
			project: { scope: "project", version: 1, settings: { models: ["b/two"] } } })).toThrow(/no allowed models/);
	});
	it("session override can tighten but cannot loosen an organization cap", () => {
		const resolved = resolveEffectivePolicy({ projectId: "p", delegatedPaths,
			organization: { scope: "organization", version: 2, settings: { limits: { tokens: 50_000 } } },
			session: { scope: "session", version: 1, settings: { limits: { tokens: 60_000 } } } });
		expect(resolved.settings.limits.tokens).toBe(50_000);
	});
});
