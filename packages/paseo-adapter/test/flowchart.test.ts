import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { collectFlowchartSource, parseFlowchartResponse } from "@pi-student/paseo-adapter/flowchart";
import { flowchartUiScript } from "@pi-student/paseo-adapter/flowchart-ui";
import { resolvePaseoProjectPath } from "@pi-student/paseo-adapter/ecosystem-bridge";

describe("student flowchart", () => {
	it("reads the current source while excluding generated files and secrets", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-flowchart-"));
		try {
			await mkdir(path.join(root, "src"));
			await mkdir(path.join(root, "node_modules"));
			await writeFile(path.join(root, "src", "main.ts"), "export function start() { return 'first'; }");
			await writeFile(path.join(root, ".env"), "SECRET=hidden");
			await writeFile(path.join(root, "credentials.json"), '{"token":"hidden"}');
			await writeFile(path.join(root, "node_modules", "ignored.js"), "generated");
			const first = await collectFlowchartSource(root);
			expect(first.text).toContain("first");
			expect(first.text).not.toMatch(/hidden|generated/);
			await writeFile(path.join(root, "src", "main.ts"), "export function start() { return 'changed'; }");
			const refreshed = await collectFlowchartSource(root);
			expect(refreshed.text).toContain("changed");
			expect(refreshed.text).not.toContain("first");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("keeps only valid nodes and edges from model output", () => {
		const graph = parseFlowchartResponse('```json\n{"title":"Demo","summary":"Flow","nodes":[{"id":"start","label":"Open app"},{"id":"end","label":"See page"}],"edges":[{"from":"start","to":"end"},{"from":"end","to":"missing"}]}\n```', 2, false);
		expect(graph.nodes).toHaveLength(2);
		expect(graph.edges).toEqual([{ from: "start", to: "end", label: "" }]);
		expect(graph.filesRead).toBe(2);
	});

	it("resolves a new workspace's selected project only through Paseo's registry", async () => {
		const home = await mkdtemp(path.join(os.tmpdir(), "pi-flowchart-project-"));
		try {
			await mkdir(path.join(home, "projects"));
			await writeFile(path.join(home, "projects", "projects.json"), JSON.stringify([
				{ displayName: "Class app", rootPath: "/tmp/class-app", archivedAt: null },
				{ displayName: "Old app", rootPath: "/tmp/old-app", archivedAt: "2026-01-01" },
			]));
			expect(await resolvePaseoProjectPath(home, "Class app")).toBe("/tmp/class-app");
			await expect(resolvePaseoProjectPath(home, "Old app")).rejects.toThrow("could not find");
			await expect(resolvePaseoProjectPath(home, "/tmp/class-app")).rejects.toThrow("could not find");
			await writeFile(path.join(home, "projects", "projects.json"), JSON.stringify([
				{ displayName: "Class app", rootPath: "/tmp/class-app" },
				{ displayName: "Class app", rootPath: "/tmp/other-app" },
			]));
			await expect(resolvePaseoProjectPath(home, "Class app")).rejects.toThrow("Several projects");
		} finally { await rm(home, { recursive: true, force: true }); }
	});

	it("installs a syntactically valid read-only flowchart tab with refresh and zoom", () => {
		const script = flowchartUiScript(6769).replace(/^\s*<script[^>]*>/, "").replace(/<\/script>\s*$/, "");
		expect(() => new Script(script)).not.toThrow();
		expect(script).toContain('"/flowchart?" + target');
		expect(script).toContain("Generating flowchart…");
		expect(script).toContain("Read-only");
		expect(script).toContain("Zoom in");
		expect(script).toContain("addMenuChoice");
		expect(script).toContain("new-workspace-launch-option-blank");
		expect(script).toContain("projectName=");
	});
});
