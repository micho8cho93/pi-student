import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createEcosystemBridgeServer, ECOSYSTEM_BRIDGE_PORT, resolvePaseoWorkspacePath } from "@pi-student/paseo-adapter/ecosystem-bridge";
import { WorkspaceEventJournal, WorkspaceEventStream } from "@pi-student/runtime/workspace-events";
import { buildWorkspaceChatContext } from "@pi-student/runtime/workspace-chat-context";

describe("ecosystem bridge", () => {
	it("uses one local bridge and resolves only registered Paseo workspace ids", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-paseo-workspaces-"));
		const paseoHome = path.join(root, "paseo");
		const project = path.join(root, "student-site");
		try {
			await mkdir(path.join(paseoHome, "projects"), { recursive: true });
			await writeFile(path.join(paseoHome, "projects", "workspaces.json"), JSON.stringify([
				{ workspaceId: "wks_student-1", cwd: project },
			]));
			expect(ECOSYSTEM_BRIDGE_PORT).toBe(6769);
			expect(await resolvePaseoWorkspacePath(paseoHome, "wks_student-1", "/fallback")).toBe(project);
			expect(await resolvePaseoWorkspacePath(paseoHome, undefined, "/fallback")).toBe("/fallback");
			await expect(resolvePaseoWorkspacePath(paseoHome, "../../etc", "/fallback")).rejects.toThrow(/identifier is invalid/);
			await expect(resolvePaseoWorkspacePath(paseoHome, "wks_missing", "/fallback")).rejects.toThrow(/active Paseo workspace/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("records student editor activity as metadata the chat runtime can read", async () => {
		const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-paseo-events-")));
		const paseoHome = path.join(root, "paseo");
		const project = path.join(root, "student-site");
		const previousHome = process.env.PI_STUDENT_HOME;
		process.env.PI_STUDENT_HOME = path.join(root, "home");
		const server = createEcosystemBridgeServer(project, paseoHome);
		try {
			await mkdir(path.join(paseoHome, "projects"), { recursive: true });
			await mkdir(project);
			await writeFile(path.join(paseoHome, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "wks_student-1", cwd: project }]));
			await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
			const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const post = (body: object) => fetch(`${base}/workspace-events?workspaceId=wks_student-1`, {
				method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" }, body: JSON.stringify(body) });
			expect((await post({ type: "file.changed", file: path.join(project, "src/app.js") })).status).toBe(202);
			expect((await post({ type: "agent.files_changed", files: [{ file: "src/app.js", kind: "modified" }] })).status).toBe(400);
			expect((await post({ type: "file.changed", file: "../other/app.js" })).status).toBe(400);
			const activity = await (await fetch(`${base}/workspace-activity?workspaceId=wks_student-1`)).json();
			expect(activity.recentChanges).toMatchObject([{ file: "src/app.js", author: "student", kind: "modified" }]);

			const runtime = new WorkspaceEventStream({ journal: new WorkspaceEventJournal(path.join(root, "home", "config", "workspace-events")) });
			await runtime.refresh({ projectPath: project });
			expect(buildWorkspaceChatContext({ ui: runtime.ui({ projectPath: project }) })).toContain("Student modified (typed themselves):\n- src/app.js");

			// Terminal → Chat: the bridge derives the test outcome from the student's command.
			expect((await post({ type: "test.failed", command: "npm test", exitCode: 1 })).status).toBe(400);
			expect((await post({ type: "terminal.command_finished", command: "npm test", exitCode: 1,
				summary: "RUN v2\nFAIL src/app.test.js > renders\nAssertionError: expected 'a' to be 'b'\nTOKEN=ghp_abcdefghijklmnopqrstuvwxyz failed" })).status).toBe(202);
			// Flowchart → Chat: node selection is validated and shared; unsafe related paths are dropped.
			expect((await post({ type: "flowchart.node_selected", id: "render", label: "Render page", file: "src/app.js", line: 4, relatedFiles: ["../x.js"] })).status).toBe(202);
			expect((await post({ type: "flowchart.node_selected", id: "x", label: "X", file: "/etc/passwd" })).status).toBe(400);
			const after = await (await fetch(`${base}/workspace-activity?workspaceId=wks_student-1`)).json();
			expect(after.tests.lastRun).toMatchObject({ command: "npm test", passed: false, exitCode: 1, actor: "student", failedTests: ["src/app.test.js > renders"] });
			expect(after.flowchart.selectedNode).toEqual({ id: "render", label: "Render page", file: "src/app.js", line: 4 });
			await runtime.refresh({ projectPath: project });
			const context = buildWorkspaceChatContext({ ui: runtime.ui({ projectPath: project }), events: runtime.events({ projectPath: project }) })!;
			expect(context).toContain("- src/app.test.js > renders failed (`npm test`, run by the student, exit 1)");
			expect(context).toContain('- Selected node: "Render page" — src/app.js:4');
			expect(context).not.toContain("ghp_");

			// Fallback actions: manual work is always available, whatever happens to AI access.
			for (const query of ["", "&model=unavailable"]) {
				const response = await fetch(`${base}/workspace-actions?workspaceId=wks_student-1${query}`);
				const { actions } = await response.json() as { actions: Array<{ action: string; available: boolean; reason?: string }> };
				expect(response.status).toBe(200);
				for (const action of ["open-editor", "use-terminal", "run-tests"]) expect(actions.find(item => item.action === action)?.available).toBe(true);
				if (query) expect(actions.find(item => item.action === "ask-guidance")).toMatchObject({ available: false, reason: "provider_unavailable" });
			}
		} finally {
			await new Promise(resolve => server.close(resolve));
			if (previousHome === undefined) delete process.env.PI_STUDENT_HOME; else process.env.PI_STUDENT_HOME = previousHome;
			await rm(root, { recursive: true, force: true });
		}
	});
});
