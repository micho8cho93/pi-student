import { describe, expect, it } from "vitest";
import type { ModelProfile } from "@pi-student/contracts";
import { resolveApprovedModel } from "../src/model-governance.js";
import { calculateEstimatedCostMicros, evaluateBudget } from "../src/usage.js";

const profiles: ModelProfile[] = [
	{ id: "advanced", organizationId: "a", displayName: "Advanced", provider: "openai", providerModel: "advanced", allowedThinkingLevels: ["high"], available: false, fallbackProfileId: "fast", version: 2 },
	{ id: "fast", organizationId: "a", displayName: "Fast", provider: "openai", providerModel: "fast", allowedThinkingLevels: ["high", "low"], available: true, version: 1 },
];

describe("model governance", () => {
	it("rejects unapproved profiles and only uses approved same-tenant fallback", () => {
		expect(resolveApprovedModel(profiles, "advanced", ["advanced", "fast"], "high").id).toBe("fast");
		expect(() => resolveApprovedModel(profiles, "fast", [], "low")).toThrow(/not approved/);
		expect(() => resolveApprovedModel(profiles, "advanced", ["advanced"], "high")).toThrow(/No approved model/);
	});
});

describe("metering", () => {
	it("keeps unknown pricing unknown and computes versioned microdollar cost", () => {
		const usage = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadTokens: 250_000, cacheWriteTokens: 0 };
		expect(calculateEstimatedCostMicros(usage)).toBeNull();
		expect(calculateEstimatedCostMicros(usage, { version: "2026-09", inputMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 4_000_000, cacheReadMicrosPerMillion: 1_000_000, cacheWriteMicrosPerMillion: 0 })).toBe(4_250_000);
	});
	it("warns before the hard limit and blocks once exceeded", () => {
		const budget = { limitMicros: 10_000, tokenLimit: null, warningFraction: 0.8, hardAction: "block_ai" as const };
		expect(evaluateBudget(budget, 7_000, 0, 1_000, 0)).toEqual({ warning: true, blocked: false, action: "warn" });
		expect(evaluateBudget(budget, 9_000, 0, 2_000, 0)).toEqual({ warning: true, blocked: true, action: "block_ai" });
	});
});
