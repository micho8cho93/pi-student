import { describe, expect, it } from "vitest";
import { resolveThinkingLevel, supportedThinkingLevels } from "../pi/thinking.js";

describe("thinking-level compatibility", () => {
	it("falls back to the nearest supported level when a model omits the requested level", () => {
		const model = { reasoning: true, thinkingLevelMap: { high: null, xhigh: null, max: null } } as const;
		expect(resolveThinkingLevel(model, "high")).toBe("medium");
	});

	it("disables reasoning for models that do not support it", () => {
		expect(supportedThinkingLevels({ reasoning: false })).toEqual(["off"]);
		expect(resolveThinkingLevel({ reasoning: false }, "max")).toBe("off");
	});

	it("keeps explicitly mapped extended levels available", () => {
		const model = { reasoning: true, thinkingLevelMap: { xhigh: "high", max: "max" } };
		expect(resolveThinkingLevel(model, "max")).toBe("max");
	});
});
