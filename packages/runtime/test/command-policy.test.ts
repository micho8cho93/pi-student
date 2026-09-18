import { describe, expect, it } from "vitest";
import { classifyTerminalCommand, isSafeInspectionCommand, isSafeVerificationCommand, isWorkspacePath } from "../src/command-policy.js";

describe("terminal command responsibility policy", () => {
	it("keeps routine implementation and project commands autonomous", () => {
		expect(classifyTerminalCommand("mkdir -p src/components", "/tmp/project")).toBe("autonomous");
		expect(classifyTerminalCommand("npm test", "/tmp/project")).toBe("autonomous");
		expect(classifyTerminalCommand("git status", "/tmp/project")).toBe("autonomous");
	});

	it("recognizes safe inspection and student checkpoints", () => {
		expect(isSafeInspectionCommand("find src -type f", "/tmp/project")).toBe(true);
		expect(isSafeVerificationCommand("npm run build", "/tmp/project")).toBe(true);
		expect(classifyTerminalCommand("git add src/App.tsx", "/tmp/project")).toBe("student-checkpoint");
	});

	it("requires approval for destructive commands", () => {
		expect(classifyTerminalCommand("rm -rf dist", "/tmp/project")).toBe("approval-required");
		expect(classifyTerminalCommand("git reset --hard HEAD", "/tmp/project")).toBe("approval-required");
	});

	it("keeps project paths inside the mounted workspace", () => {
		expect(isWorkspacePath("/workspace/src/app.ts", "/workspace")).toBe(true);
		expect(isWorkspacePath("/Users/student/project/src/app.ts", "/workspace")).toBe(false);
		expect(isWorkspacePath("../outside.txt", "/workspace")).toBe(false);
	});
});
