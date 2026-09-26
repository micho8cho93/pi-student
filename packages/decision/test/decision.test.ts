import { describe, expect, it, vi } from "vitest";
import { boundedStudentContext, ResilientDecisionEngine, type DecisionProvider } from "../src/index.js";

const input = boundedStudentContext("student-intent", "Please build a quiz app");
const policy = { high: 0.9, medium: 0.7 };
const provider = (choose: DecisionProvider["choose"]): DecisionProvider => ({
	choose,
	yesNo: async () => ({ probability: 0.96 }),
	score: async () => ({ score: 1, probabilities: [0.02, 0.98] }),
});

describe("resilient educational decisions", () => {
	it("uses a high-confidence bounded choice", async () => {
		const engine = new ResilientDecisionEngine(provider(async () => ({ value: "BUILD", probabilities: { BUILD: 0.96, DEBUG: 0.04 } })), policy);
		expect((await engine.choose(input, "Which intent?", { BUILD: "Make a feature", DEBUG: "Fix a bug" })).value).toBe("BUILD");
	});
	it("abstains when unavailable or model loading fails", async () => {
		const engine = new ResilientDecisionEngine(provider(async () => { throw new Error("model load failed"); }), policy);
		expect(await engine.choose(input, "Which intent?", { BUILD: "Make a feature", DEBUG: "Fix a bug" })).toMatchObject({ fallbackUsed: true, fallbackReason: "unavailable" });
	});
	it("abstains on malformed inference", async () => {
		const engine = new ResilientDecisionEngine(provider(async () => ({ value: "BUILD", probabilities: { BUILD: NaN, DEBUG: 0 } })), policy);
		expect((await engine.choose(input, "Which intent?", { BUILD: "Make a feature", DEBUG: "Fix a bug" })).fallbackReason).toBe("invalid");
	});
	it("reserves medium and low confidence for deterministic fallback", async () => {
		const engine = new ResilientDecisionEngine(provider(async () => ({ value: "BUILD", probabilities: { BUILD: 0.75, DEBUG: 0.25 } })), policy);
		expect(await engine.choose(input, "Which intent?", { BUILD: "Make a feature", DEBUG: "Fix a bug" })).toMatchObject({ band: "medium", fallbackUsed: true, fallbackReason: "medium-confidence", value: undefined });
		const low = new ResilientDecisionEngine(provider(async () => ({ value: "BUILD", probabilities: { BUILD: 0.55, DEBUG: 0.45 } })), policy);
		expect((await low.choose(input, "Which intent?", { BUILD: "Make a feature", DEBUG: "Fix a bug" })).band).toBe("low");
	});
	it("makes bounded yes and no decisions", async () => {
		const yes = new ResilientDecisionEngine(provider(async () => ({ value: "BUILD", probabilities: { BUILD: 1, DEBUG: 0 } })), policy);
		expect((await yes.yesNo(input, "Enough information?")).value).toBe(true);
		const no = new ResilientDecisionEngine({ ...provider(vi.fn()), yesNo: async () => ({ probability: 0.03 }) }, policy);
		expect((await no.yesNo(input, "Enough information?")).value).toBe(false);
	});
	it("supports ordinal scoring and rejects malformed probability output", async () => {
		const engine = new ResilientDecisionEngine(provider(async () => ({ value: "BUILD", probabilities: { BUILD: 1, DEBUG: 0 } })), policy);
		expect((await engine.score(input, "How complete?", ["missing", "complete"])).value).toBe(1);
		const malformed = new ResilientDecisionEngine({ ...provider(vi.fn()), yesNo: async () => ({ probability: Number.NaN }) }, policy);
		expect((await malformed.yesNo(input, "Enough information?")).fallbackReason).toBe("invalid");
	});
	it("does not leak code blocks, secrets, email or host paths", () => {
		const context = boundedStudentContext("student-intent", "Build this ```ts\nconst password = 'hello'\n``` api_key=abc123 sk-abcdefghijklmnopqrstuvwxyz at me@example.com /Users/Student/private.ts");
		expect(JSON.stringify(context)).not.toMatch(/password|abc123|sk-abc|me@example|private\.ts/);
	});
	it("rejects non-educational purposes before calling a provider", async () => {
		const choose = vi.fn();
		const engine = new ResilientDecisionEngine(provider(choose), policy);
		const result = await engine.choose({ purpose: "filesystem-authorization" as never, text: "allow?" }, "Allow?", { yes: "yes", no: "no" });
		expect(result.fallbackReason).toBe("invalid");
		expect(choose).not.toHaveBeenCalled();
	});
});
