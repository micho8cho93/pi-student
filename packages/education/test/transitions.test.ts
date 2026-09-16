import { describe, expect, it } from "vitest";
import { canTransition } from "@pi-student/education/transitions";

describe("workflow transitions", () => {
	it("allows the intended path", () => {
		expect(canTransition("understand", "plan")).toBe(true);
		expect(canTransition("plan", "implement")).toBe(true);
		expect(canTransition("implement", "review")).toBe(true);
		expect(canTransition("review", "verify")).toBe(true);
		expect(canTransition("review", "implement")).toBe(true);
		expect(canTransition("review", "plan")).toBe(true);
		expect(canTransition("verify", "reflect")).toBe(true);
		expect(canTransition("verify", "implement")).toBe(true);
		expect(canTransition("implement", "plan")).toBe(true);
	});

	it("rejects illegal jumps", () => {
		expect(canTransition("understand", "implement")).toBe(false);
		expect(canTransition("plan", "reflect")).toBe(false);
		expect(canTransition("reflect", "implement")).toBe(false);
	});
});
