import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readProjectProgress } from "../src/project-progress.js";
import { projectProgressUiScript } from "../src/project-progress-ui.js";

describe("project progress", () => {
	it("reads the existing learning snapshot for only the selected Pi conversation", async () => {
		const home = await mkdtemp(path.join(os.tmpdir(), "pi-progress-"));
		const project = path.join(home, "project");
		const directory = path.join(home, "agents", project.replace(/^\//, "").replace(/[\\/]/g, "-"));
		const sessionFile = path.join(home, "session.jsonl");
		try {
			await mkdir(directory, { recursive: true });
			await mkdir(project);
			await writeFile(path.join(directory, "agent-1.json"), JSON.stringify({ id: "agent-1", provider: "pi-student", workspaceId: "wks_one", cwd: project, persistence: { nativeHandle: sessionFile } }));
			await writeFile(sessionFile, [
				JSON.stringify({ type: "custom", customType: "pi-student-workflow", data: { cwd: project, stage: "plan", understanding: { ready: true }, plan: { approved: false, steps: [] } } }),
				JSON.stringify({ type: "custom", customType: "pi-student-workflow", data: { cwd: project, stage: "implement", goal: "Reconnect reliably", understanding: { ready: true }, plan: { approved: true, steps: [{ description: "Implement reconnect handler", status: "active" }] }, verification: { passed: false } } }),
			].join("\n") + "\n");
			expect(await readProjectProgress(home, project, "wks_one", "agent-1")).toMatchObject({ stage: "implement", goal: "Reconnect reliably", planApproved: true, activeStep: "Implement reconnect handler" });
			expect(await readProjectProgress(home, project, "wks_other", "agent-1")).toBeNull();
			expect(await readProjectProgress(home, project, "wks_one", "../agent-1")).toBeNull();
		} finally { await rm(home, { recursive: true, force: true }); }
	});

	it("emits a valid browser script", () => {
		const source = projectProgressUiScript(6769).replace(/^\s*<script[^>]*>/, "").replace(/<\/script>\s*$/, "");
		expect(() => new Function(source)).not.toThrow();
	});
});
