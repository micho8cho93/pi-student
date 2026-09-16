import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "@pi-student/telemetry/privacy";

describe("learning evidence privacy", () => {
	it("redacts common credentials from student-authored evidence", () => {
		expect(redactSensitiveText("I used api_key=super-secret-value today")).toBe("I used api_key=[redacted] today");
		expect(redactSensitiveText("token Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
		expect(redactSensitiveText("sk-abcdefghijklmnopqrstuvwxyz")).toBe("[redacted credential]");
	});
});
