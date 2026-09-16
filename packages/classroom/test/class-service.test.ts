import { describe, expect, it, vi } from "vitest";
import { generateJoinCode, normalizeJoinCode, joinClass } from "@pi-student/classroom/class-service";

describe("class join codes", () => {
	it("generates six non-ambiguous random characters", () => {
		const code = generateJoinCode(size => Buffer.from(Array.from({ length: size }, (_, index) => index + 1)));
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
	});

	it("normalizes valid codes and rejects malformed ones", () => {
		expect(normalizeJoinCode(" abc-234 ")).toBe("ABC-234");
		expect(() => normalizeJoinCode("O0O-111")).toThrow(/ABC-234/);
		expect(() => normalizeJoinCode("short")).toThrow(/ABC-234/);
	});
});


it("normalizes join codes before calling the repository", async () => {
 const repository = { joinClass: vi.fn(async () => ({ classId: "new-class", status: "active" as const })) };
 await joinClass(repository as never, " abc-234 ");
 expect(repository.joinClass).toHaveBeenCalledWith("ABC-234");
});

it("returns the repository membership result", async () => {
 const repository = { joinClass: vi.fn(async () => ({ classId: "new-class", status: "pending" as const })) };
 expect(await joinClass(repository as never, "ABC-234")).toEqual({ classId: "new-class", status: "pending" });
});
