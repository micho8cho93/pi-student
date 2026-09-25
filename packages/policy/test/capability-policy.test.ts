import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CAPABILITY_POLICY, allowedReasoningLevels, modelAllowed, parseCapabilityPolicy } from "@pi-student/policy/capability-policy";
import { CapabilityState, guardCapabilitySession } from "@pi-student/policy/capability-runtime";

const policy = () => structuredClone(DEFAULT_CAPABILITY_POLICY);
const model = { provider: "test", id: "a", reasoning: true };
function state() { const result = new CapabilityState(); result.select({ projectId: "p", version: 2, settings: policy() }); return result; }
describe("project capability controls", () => {
	it("preserves defaults without sharing mutable arrays", () => { const p = parseCapabilityPolicy(null); p.reasoningLevels.length = 0; expect(policy().reasoningLevels.length).toBe(7); });
	it("supports non-contiguous teacher-selected reasoning levels", () => { const p = policy(); p.reasoningLevels = ["low", "high", "max"]; expect(allowedReasoningLevels(p, model)).toEqual(["low", "high"]); });
	it("does not substitute off when the teacher disabled it", () => { const p = policy(); p.reasoningLevels = ["high"]; expect(modelAllowed(p, { ...model, reasoning: false })).toBe(false); });
	it.each([{ levels: [] }, { levels: ["ultra"] }, { levels: ["bogus"] }])("rejects invalid reasoning choices $levels", ({ levels }) => { expect(() => parseCapabilityPolicy({ ...policy(), reasoningLevels: levels })).toThrow(); });
	it("rejects invalid budget values", () => { expect(() => parseCapabilityPolicy({ ...policy(), limits: { ...policy().limits, turns: -2 } })).toThrow(); });
	it("keeps accommodations independent of editing permissions", () => { const p = policy(); p.fileEditing = false; p.accessibility.dictation = true; expect(parseCapabilityPolicy(p).fileEditing).toBe(false); });
	it("starts a new independent policy snapshot when the project changes", () => { const s = state(); s.block("terminal"); s.turns = 10; s.select({ projectId: "other", version: 1, settings: policy() }); expect(s.blocked).toEqual({}); expect(s.turns).toBe(0); expect(s.effective?.projectId).toBe("other"); });
	it("enforces reasoning and model choices at the session boundary", async () => {
		const s = state(); s.settings.reasoningLevels = ["low", "high"]; s.settings.models = ["test/a"];
		const session = { model, thinkingLevel: "medium", getAvailableThinkingLevels: () => ["off", "low", "medium", "high"], setThinkingLevel: vi.fn(function(this: any, level: string) { this.thinkingLevel = level; }), setModel: vi.fn(), prompt: vi.fn() };
		guardCapabilitySession(session as never, s);
		expect(session.getAvailableThinkingLevels()).toEqual(["low", "high"]);
		expect(() => session.setThinkingLevel("medium")).toThrow();
		await expect(session.setModel({ ...model, id: "b" })).rejects.toThrow();
		await session.prompt("hello"); expect(session.thinkingLevel).toBe("low");
	});
});
