import { describe, expect, it, vi } from "vitest";
import type { DecisionEngine } from "@pi-student/decision";
import { evaluateDecision } from "../../../scripts/evaluate-decision.js";
import { sufficiencyFixtures } from "../../decision/test/fixtures.js";
import { DeterministicDecisionEngine } from "../src/deterministic-decision-engine.js";

describe("generic decision evaluation", () => {
	it("covers at least 25 unique context cases and required scenarios", () => {
		expect(sufficiencyFixtures.length).toBeGreaterThanOrEqual(25);
		expect(new Set(sufficiencyFixtures.map(item => item.id)).size).toBe(sufficiencyFixtures.length);
		for (const scenario of ["debug-complete", "debug-missing", "build-vague", "build-detailed", "explain-", "tutor-step", "build-missing-language", "build-stack-inferred", "ambiguous-"]) {
			expect(sufficiencyFixtures.some(item => item.id.includes(scenario))).toBe(true);
		}
	});
	it("runs deterministic routing and every sufficiency fixture without storing prompts", async () => {
		const report = await evaluateDecision(new DeterministicDecisionEngine());
		expect(report.intentSummary.baselineAccuracy).toEqual({ correct: 19, total: 20 });
		expect(report.sufficiencySummary.count).toBe(sufficiencyFixtures.length);
		expect(report.sufficiencySummary.fallbackCount).toBe(sufficiencyFixtures.length);
		expect(JSON.stringify(report)).not.toContain("Build a flashcard app");
	});
	it("compares an injected candidate and its abstention fallback", async () => {
		const candidate: DecisionEngine = {
			choose: vi.fn().mockResolvedValue({ value: undefined, latencyMs: 5, fallbackUsed: true, fallbackReason: "unavailable" }),
			yesNo: vi.fn().mockResolvedValue({ value: undefined, latencyMs: 7, fallbackUsed: true, fallbackReason: "unavailable" }),
			score: vi.fn(),
		};
		const report = await evaluateDecision(candidate, "mock");
		expect(report.candidate).toBe("mock");
		expect(report.intentSummary.fallbackAccuracy).toEqual(report.intentSummary.baselineAccuracy);
		expect(report.sufficiencySummary.fallbackAccuracy).toEqual(report.sufficiencySummary.baselineAccuracy);
		expect(report.latencyMs.median).toBeGreaterThanOrEqual(5);
	});
});
