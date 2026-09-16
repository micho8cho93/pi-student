import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createSaveToDesktopExtension } from "@pi-student/runtime/save-to-desktop";
import { SANDBOX_WORKSPACE, type SandboxRuntime } from "@pi-student/sandbox/types";
import { createLearningSession } from "@pi-student/education/types";
import { WorkflowController } from "@pi-student/education/workflow-controller";

type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function registerTool(controller: WorkflowController, runtime: SandboxRuntime, desktopDirectory: string, maxBytes?: number): RegisteredTool {
	let registered: RegisteredTool | undefined;
	const pi = {
		registerTool(tool: RegisteredTool) {
			registered = tool;
		},
	} as unknown as ExtensionAPI;
	createSaveToDesktopExtension(controller, runtime, { desktopDirectory, maxBytes })(pi);
	if (!registered) throw new Error("save_to_desktop was not registered");
	return registered;
}

function runtimeWithFile(content: Uint8Array): SandboxRuntime {
	return {
		start: async () => undefined,
		stop: async () => undefined,
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		readFile: async () => Buffer.from(content).toString("utf8"),
		readBytes: async () => content,
		writeFile: async () => undefined,
		fileExists: async (candidate) => candidate === "/workspace/output.bin",
		listFiles: async () => ["/workspace/output.bin"],
		getWorkspacePath: () => SANDBOX_WORKSPACE,
		isRunning: () => true,
		stat: async () => ({ isDirectory: () => false }),
	};
}

function context(confirm = true, hasUI = true) {
	return {
		hasUI,
		ui: { confirm: async () => confirm },
	} as never;
}

describe("verified Desktop export", () => {
	it("copies the exact sandbox bytes after verification and confirmation", async () => {
		const desktop = await mkdtemp(path.join(os.tmpdir(), "pi-student-desktop-"));
		try {
			const controller = new WorkflowController(createLearningSession("/host/project"));
			controller.state.verification.passed = true;
			const bytes = Uint8Array.from([0, 1, 2, 255]);
			const tool = registerTool(controller, runtimeWithFile(bytes), desktop);

			const response = await tool.execute("export-1", { source: "output.bin", filename: "finished.bin" }, undefined, undefined, context());

			expect(response).not.toHaveProperty("isError", true);
			expect(await readFile(path.join(desktop, "finished.bin"))).toEqual(Buffer.from(bytes));
			expect(response.details).toMatchObject({ filename: "finished.bin", size: 4 });
		} finally {
			await rm(desktop, { recursive: true, force: true });
		}
	});

	it("refuses export before a passing verification result", async () => {
		const desktop = await mkdtemp(path.join(os.tmpdir(), "pi-student-desktop-"));
		try {
			const controller = new WorkflowController(createLearningSession("/host/project"));
			const tool = registerTool(controller, runtimeWithFile(Buffer.from("unverified")), desktop);

			const response = await tool.execute("export-2", { source: "output.bin" }, undefined, undefined, context());

			expect(response).toHaveProperty("isError", true);
			expect(await readFile(path.join(desktop, "output.bin")).catch(() => undefined)).toBeUndefined();
		} finally {
			await rm(desktop, { recursive: true, force: true });
		}
	});

	it("requires interactive confirmation and rejects traversal, oversize files, and overwrites", async () => {
		const desktop = await mkdtemp(path.join(os.tmpdir(), "pi-student-desktop-"));
		try {
			const controller = new WorkflowController(createLearningSession("/host/project"));
			controller.state.verification.passed = true;
			const runtime = runtimeWithFile(Buffer.from("verified"));
			const tool = registerTool(controller, runtime, desktop, 4);

			expect(await tool.execute("export-3", { source: "output.bin" }, undefined, undefined, context(true, false))).toHaveProperty("isError", true);
			expect(await tool.execute("export-4", { source: "output.bin", filename: "../escape.bin" }, undefined, undefined, context())).toHaveProperty("isError", true);
			expect(await tool.execute("export-5", { source: "output.bin" }, undefined, undefined, context())).toHaveProperty("isError", true);

			const overwriteTool = registerTool(controller, runtime, desktop);
			await writeFile(path.join(desktop, "output.bin"), "keep me");
			expect(await overwriteTool.execute("export-6", { source: "output.bin" }, undefined, undefined, context())).toHaveProperty("isError", true);
			expect(await readFile(path.join(desktop, "output.bin"), "utf8")).toBe("keep me");
		} finally {
			await rm(desktop, { recursive: true, force: true });
		}
	});
});
