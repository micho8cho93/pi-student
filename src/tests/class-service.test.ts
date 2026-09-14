import { describe, expect, it, vi } from "vitest";
import { generateJoinCode, normalizeJoinCode, joinClass } from "../teacher/class-service.js";

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


const contextStorage = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("../telemetry/local-store.js", () => ({
 readTeacherContext: async () => ({ classId: "old-class", projectId: "old-project", requirementIds: ["old-requirement"], standardIds: ["old-standard"] }),
 writeTeacherContext: contextStorage.write,
}));

it("clears the previous class's project and standards when joining another class", async () => {
 contextStorage.write.mockClear();
 const client = { rpc: async () => ({ data: [{ class_id: "new-class", membership_status: "active" }] }) };
 await joinClass(client as never, "ABC-234");
 expect(contextStorage.write).toHaveBeenCalledWith({ classId: "new-class" });
});

it("does not activate a pending membership for learning records", async () => {
 contextStorage.write.mockClear();
 const client = { rpc: async () => ({ data: [{ class_id: "new-class", membership_status: "pending" }] }) };
 expect(await joinClass(client as never, "ABC-234")).toEqual({ classId: "new-class", status: "pending" });
 expect(contextStorage.write).not.toHaveBeenCalled();
});
