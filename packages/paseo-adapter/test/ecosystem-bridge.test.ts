import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ECOSYSTEM_BRIDGE_PORT, resolvePaseoWorkspacePath } from "@pi-student/paseo-adapter/ecosystem-bridge";

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
});
