import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("model-free application startup", () => {
	it("imports the runtime without a model directory or Laya package", async () => {
		const previous = process.env.PI_STUDENT_LAYA_MODEL_DIR;
		process.env.PI_STUDENT_LAYA_MODEL_DIR = "/nonexistent/model";
		try {
			await expect(import("../src/create-session.js")).resolves.toHaveProperty("createLearningAgentRuntime");
			const runtimePackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
			const lock = await readFile(new URL("../../../package-lock.json", import.meta.url), "utf8");
			expect(JSON.stringify(runtimePackage.dependencies)).not.toMatch(/laya|onnx/i);
			expect(lock).not.toMatch(/@receptron\/laya|@pi-student\/decision-laya/);
		} finally {
			if (previous === undefined) delete process.env.PI_STUDENT_LAYA_MODEL_DIR;
			else process.env.PI_STUDENT_LAYA_MODEL_DIR = previous;
		}
	});
});
