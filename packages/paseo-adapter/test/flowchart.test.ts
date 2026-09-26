import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { collectFlowchartSource, findFlowchartNodesForFile, FlowchartModelError, generateFlowchart, locateSymbolLine, parseFlowchartResponse } from "@pi-student/paseo-adapter/flowchart";
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
			expect(admission).toHaveBeenCalledWith("openai", "approved", "off", "architecture");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("preserves structured outage classification for unbound fallback and never turns cancellation into an outage", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-flowchart-health-"));
		try {
			await writeFile(path.join(root, "main.ts"), "export const ready = true;");
			const model = { provider: "school", id: "tutor", reasoning: false };
			const context = { identity: { kind: "personal" }, workspacePath: root, sandbox: { mode: "gondolin" } } as ExecutionContext;
			for (const [error, status] of [[Object.assign(new Error("private provider response"), { status: 503 }), "provider_unavailable"],
				[Object.assign(new Error("503 request cancelled"), { name: "AbortError" }), undefined]] as const) {
				const runtime = { getAvailable: async () => [model], getProviderAuthStatus: () => ({ configured: true }), completeSimple: async () => { throw error; } } as unknown as ModelRuntime;
				const report = vi.fn();
				await expect(generateFlowchart(root, runtime, context, undefined, report)).rejects.toMatchObject({ health: status ? { status } : undefined });
				if (status) expect(report).toHaveBeenCalledWith({ status });
				else expect(report).not.toHaveBeenCalled();
			}
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("links nodes to source only through files the generator read", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-flowchart-refs-"));
		try {
			await mkdir(path.join(root, "src"));
			await writeFile(path.join(root, "src", "socket.ts"), "import { retry } from './retry';\n\nexport async function reconnect(attempt: number) {\n  return retry(attempt);\n}\n");
			await writeFile(path.join(root, "src", "retry.ts"), "export const retry = (n: number) => n;\n");
			await writeFile(path.join(root, ".env"), "SECRET=hidden");
			const nodes = [
				{ id: "reconnect", label: "Reconnect", file: "src/socket.ts", symbol: "reconnect", line: 999, relatedFiles: ["./src/retry.ts", "../outside.ts", ".env", "src/socket.ts"] },
				{ id: "guess", label: "Guessed line", file: "src/retry.ts", line: 999 },
				{ id: "outside", label: "Outside", file: "../other/app.ts", symbol: "run" },
				{ id: "secret", label: "Secrets", file: ".env", line: 1 },
				{ id: "missing", label: "Missing", file: "src/missing.ts" },
				{ id: "absolute", label: "Absolute", file: path.join(root, "src", "socket.ts") },
				{ id: "injected", label: "Injected symbol", file: "src/retry.ts", symbol: "x; rm -rf /" },
				{ id: "plain", label: "Plain step" },
			];
			const completeSimple = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ title: "Demo", nodes, edges: [] }) }] }));
			const model = { provider: "openai", id: "approved", name: "Approved", reasoning: false };
			const runtime = { getAvailable: async () => [model], getProviderAuthStatus: () => ({ configured: true }), completeSimple } as unknown as ModelRuntime;
			const context = { identity: { kind: "personal" }, workspacePath: root, sandbox: { mode: "gondolin" } } as ExecutionContext;
			const chart = await generateFlowchart(root, runtime, context);
			const byId = Object.fromEntries(chart.nodes.map(node => [node.id, node]));
			expect(byId.reconnect).toMatchObject({ file: "src/socket.ts", symbol: "reconnect", line: 3, relatedFiles: ["src/retry.ts"] });
			expect(byId.guess).toEqual(expect.objectContaining({ file: "src/retry.ts" }));
			expect(byId.guess).not.toHaveProperty("line");
			for (const id of ["outside", "secret", "missing", "absolute", "plain"]) {
				expect(byId[id]).not.toHaveProperty("file");
				expect(byId[id]).not.toHaveProperty("symbol");
			}
			expect(byId.injected).not.toHaveProperty("symbol");
			expect(findFlowchartNodesForFile(chart, "src/retry.ts").map(node => node.id)).toEqual(["reconnect", "guess", "injected"]);
			expect(findFlowchartNodesForFile(chart, path.join(root, "src", "socket.ts")).map(node => node.id)).toEqual(["reconnect"]);
			expect(locateSymbolLine("class Socket {}\nconst open = () => 1;\n", "Socket.open")).toBe(2);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("reports model failures separately so the existing map and manual work stay usable", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-flowchart-outage-"));
		try {
			await writeFile(path.join(root, "main.ts"), "export const ready = true;");
			const model = { provider: "openai", id: "approved", name: "Approved", reasoning: false };
			const context = { identity: { kind: "personal" }, workspacePath: root, sandbox: { mode: "gondolin" } } as ExecutionContext;
			for (const completeSimple of [vi.fn(async () => { throw new Error("fetch failed"); }), vi.fn(async () => ({ stopReason: "error", errorMessage: "503", content: [] }))]) {
				const runtime = { getAvailable: async () => [model], getProviderAuthStatus: () => ({ configured: true }), completeSimple } as unknown as ModelRuntime;
				await expect(generateFlowchart(root, runtime, context)).rejects.toBeInstanceOf(FlowchartModelError);
			}
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("keeps only valid nodes and edges from model output", () => {
		const graph = parseFlowchartResponse('```json\n{"title":"Demo","summary":"Flow","nodes":[{"id":"start","label":"Open app"},{"id":"end","label":"See page"}],"edges":[{"from":"start","to":"end"},{"from":"end","to":"missing"}]}\n```', 2, false);
		expect(graph.nodes).toHaveLength(2);
		expect(graph.edges).toEqual([{ from: "start", to: "end", label: "" }]);
		expect(graph.filesRead).toBe(2);
	});

	it("generates Learn explanations with the map, so toggling Learn only changes what is shown", () => {
		const long = "word ".repeat(200);
		const graph = parseFlowchartResponse(JSON.stringify({ title: "Chat", summary: "Flow", nodes: [
			{ id: "connect", label: "Connect", detail: "Opens the socket", explanation: "  Opens the WebSocket.\nEverything after it\tdepends on this connection.  " },
			{ id: "retry", label: "Retry", detail: "Schedules reconnects", explanation: long },
			{ id: "done", label: "Done" },
		], edges: [] }), 1, false);
		expect(graph.nodes[0]).toMatchObject({ detail: "Opens the socket", explanation: "Opens the WebSocket. Everything after it depends on this connection." });
		expect(graph.nodes[1]!.explanation!.length).toBeLessThanOrEqual(400);
		expect(graph.nodes[2]).not.toHaveProperty("explanation");

		const script = flowchartUiScript(6769);
		expect(script).toContain("(state.learn && node.explanation) || node.detail");
		expect(script).toContain('"Leads to "');
		expect(script).toContain("Learn: Chat will explain from this step.");
		// Learn arrives with the workspace snapshot of the Chat the map follows and re-renders the existing map; it never requests a new one.
		const check = script.slice(script.indexOf("const checkStale"), script.indexOf("const ensurePanel"));
		expect(check).toContain('snapshot.learn?.flowchart?.detail === "educational"');
		expect(check).toContain("&agentId=");
		expect(check).toContain("render()");
		expect(check).not.toMatch(/generate\(|\/flowchart\?/);
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
		expect(script).toContain('"flowchart.node_selected"');
		expect(script).toContain('"open", "file:" + encoded');
		expect(script).toContain("pi-student:file-opened");
		expect(script).toContain("Showing the previous flowchart.");
		// Paseo decodes ?open=file:<base64url>; the browser encoding must match it.
		const encode = new Function("file", `return ${script.match(/const encoded = ([^;]+);/)![1]};`) as (file: string) => string;
		for (const file of ["src/socket.ts", "src/ünïcode/a+b?.ts"]) expect(encode(file)).toBe(Buffer.from(file, "utf8").toString("base64url"));
	});
});
