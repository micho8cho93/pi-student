import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { collectFlowchartSource, generateFlowchart, parseFlowchartResponse } from "@pi-student/paseo-adapter/flowchart";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExecutionContext } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
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
			await writeFile(path.join(root, "tokens.json"), '{"token":"token-hidden"}');
			await writeFile(path.join(root, "src", "private.pem"), "private-hidden");
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

	it("uses the shared approved model for execution and reports the actual model", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-flowchart-model-"));
		try {
			await writeFile(path.join(root, "main.ts"), "export const ready = true;");
			const approved = { provider: "openai", id: "approved", name: "Approved", reasoning: false };
			const denied = { provider: "other", id: "denied", name: "Denied", reasoning: false };
			const completeSimple = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: '{"title":"Demo","nodes":[{"id":"one","label":"One"}],"edges":[]}' }] }));
			const runtime = { getAvailable: async () => [denied, approved], getProviderAuthStatus: () => ({ configured: true }), completeSimple } as unknown as ModelRuntime;
			const context: ExecutionContext = { identity: { kind: "student", userId: "student", classId: "class", projectId: "project", organizationId: "org" }, workspacePath: root, sandbox: { mode: "gondolin", internetAllowed: true },
				projectId: "project", classId: "class", organizationId: "org", environment: { status: "active", provider: "gondolin", capabilities: { provider: "gondolin", mode: "gondolin", capabilities: ["workspace"] }, requiredCapabilities: ["workspace"] }, policy: { projectId: "project", version: 1, sourceVersions: { organization: 1 },
					settings: { ...DEFAULT_CAPABILITY_POLICY, models: ["openai/approved"] } } };
			const admission = vi.fn(async () => {});
			const result = await generateFlowchart(root, runtime, context, admission);
			expect(result.model).toBe("openai/approved");
			expect(completeSimple).toHaveBeenCalledWith(approved, expect.anything(), expect.anything());
			expect(admission).toHaveBeenCalledWith("openai", "approved", "off");
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
