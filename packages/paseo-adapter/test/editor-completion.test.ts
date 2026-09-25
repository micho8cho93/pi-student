import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import type { AddressInfo } from "node:net";
import { EditorCompletionService } from "@pi-student/paseo-adapter/editor-completion";
import { editorCompletionUiScript } from "@pi-student/paseo-adapter/editor-completion-ui";
import { patchFileEditorSource } from "@pi-student/paseo-adapter/file-editor-patch";
import { createEcosystemBridgeServer } from "@pi-student/paseo-adapter/ecosystem-bridge";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { ExecutionContext } from "@pi-student/contracts";

const context = (root: string, policy?: ExecutionContext["policy"], organizationId?: string): ExecutionContext => ({
	workspacePath: root, identity: { kind: organizationId ? "student" : "personal" }, sandbox: { mode: "gondolin" },
	policy, ...(organizationId ? { organizationId } : {}),
});

const require = createRequire(import.meta.url);
const bundle = path.resolve(path.dirname(require.resolve("@getpaseo/cli/package.json")), "..", "server", "dist", "server", "web-ui", "_expo", "static", "js", "web", "index-1be98d8895969110732458bbaeac57b2.js");

describe("student file completion", () => {
	it("hooks the installed Paseo CodeMirror view once and keeps the UI script valid", async () => {
		const source = await readFile(bundle, "utf8");
		const patched = patchFileEditorSource(source);
		expect(patched).toContain("globalThis.piStudentFileEditor?.(f,t.model.getSnapshot().version?.path||x)");
		expect(patchFileEditorSource(patched)).toBe(patched);
		expect(() => new Script(patched)).not.toThrow();
		const script = editorCompletionUiScript(6769).replace(/^\s*<script[^>]*>/, "").replace(/<\/script>\s*$/, "");
		expect(() => new Script(script)).not.toThrow();
		expect(script).toContain("AI suggestions send excerpts of the open file");
		expect(script).toContain("No nearby files are included");
		expect(script).toContain("The selected model is unavailable. Choose another model.");
		expect(script).toContain('status.textContent = "Using " + body.model');
		expect(script).toContain("local(false)");
		expect(script).toContain("enabled: value.enabled === true");
	});

	it("keeps AI suggestions off when editing or managed model access is disabled", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-completion-policy-"));
		const model = { provider: "openai", id: "small", name: "Small", reasoning: false, cost: { input: 1, output: 1 } };
		const runtime = { getAvailable: async () => [model], getProviderAuthStatus: () => ({ configured: true }) };
		try {
			const noEditing = new EditorCompletionService(async () => ({ runtime: runtime as never, context: context(root, { projectId: "project", version: 1, settings: { ...DEFAULT_CAPABILITY_POLICY, fileEditing: false } }) }), path.join(root, "editing.json"));
			expect(await noEditing.models(root)).toEqual([]);
			await expect(noEditing.suggest(root, { filename: "main.ts", content: "hello", cursor: 5, model: "auto" })).rejects.toMatchObject({ status: 403 });
			const noModels = new EditorCompletionService(async () => ({ runtime: runtime as never, context: context(root, { projectId: "project", version: 1, settings: DEFAULT_CAPABILITY_POLICY }, "org") }), path.join(root, "models.json"));
			expect(await noModels.models(root)).toEqual([]);
			await expect(noModels.suggest(root, { filename: "main.ts", content: "hello", cursor: 5, model: "auto" })).rejects.toMatchObject({ status: 403 });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("uses approved models and only the open file, and rejects unsafe file paths", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-completion-"));
		const completeSimple = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: "World" }] }));
		const models = [
			{ provider: "openai", id: "small", name: "Small", reasoning: false, cost: { input: 1, output: 1 } },
			{ provider: "other", id: "blocked", name: "Blocked", reasoning: false, cost: { input: 0, output: 0 } },
		];
		const runtime = { getAvailable: async () => models, getProviderAuthStatus: () => ({ configured: true }), completeSimple };
		const policy = { projectId: "project", version: 1, settings: { ...DEFAULT_CAPABILITY_POLICY, models: ["openai/small"] } };
		const beforeRequest = vi.fn(async () => {});
		const service = new EditorCompletionService(async () => ({ runtime: runtime as never, context: context(root, policy), beforeRequest }), path.join(root, "usage.json"));
		try {
			await mkdir(path.join(root, "src"));
			await writeFile(path.join(root, "src", "helper.ts"), "export const nearbySymbol = 1;");
			await writeFile(path.join(root, "src", "secret-token.ts"), "DO_NOT_SEND");
			expect(await service.models(root)).toEqual([{ id: "openai/small", label: "Small" }]);
			const result = await service.suggest(root, { filename: "src/main.ts", content: "const greeting = 'Hello'", cursor: 24, model: "auto" });
			expect(result.suggestion).toBe("World");
			expect(result.model).toBe("openai/small");
			expect(completeSimple.mock.calls[0]![0]).toMatchObject({ provider: "openai", id: "small" });
			expect(beforeRequest).toHaveBeenCalledWith("openai", "small", "off");
			const prompt = completeSimple.mock.calls[0]![1].messages[0].content[0].text;
			expect(prompt).not.toContain("nearbySymbol");
			expect(prompt).not.toContain("DO_NOT_SEND");
			for (const filename of ["src/credentials.json", "src/private-key.ts", "src/service-account.json", "src/.env.local", "src/.ssh/config.json"]) {
				await expect(service.suggest(root, { filename, content: "secret", cursor: 6, model: "auto" })).rejects.toMatchObject({ status: 403 });
			}
			await expect(service.suggest(root, { filename: "../other.ts", content: "hello", cursor: 5, model: "auto" })).rejects.toThrow("unavailable");
			await expect(service.suggest(root, { filename: "src/main.ts", content: "hello", cursor: 5, model: "other/blocked" })).rejects.toThrow("not approved");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("enforces the server request limit", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-completion-limit-"));
		const model = { provider: "openai", id: "small", name: "Small", reasoning: false, cost: { input: 1, output: 1 } };
		const completeSimple = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: "x" }] }));
		const environment = async () => ({ runtime: { getAvailable: async () => [model], getProviderAuthStatus: () => ({ configured: true }), completeSimple } as never, context: context(root) });
		const usagePath = path.join(root, "usage.json");
		const service = new EditorCompletionService(environment, usagePath);
		try {
			for (let i = 0; i < 10; i++) await service.suggest(root, { filename: "main.ts", content: "hello", cursor: 5, model: "auto" });
			await expect(service.suggest(root, { filename: "main.ts", content: "hello", cursor: 5, model: "auto" })).rejects.toMatchObject({ status: 429 });
			expect(completeSimple).toHaveBeenCalledTimes(10);
			const restarted = new EditorCompletionService(environment, usagePath);
			await expect(restarted.suggest(root, { filename: "main.ts", content: "hello", cursor: 5, model: "auto" })).rejects.toMatchObject({ status: 429 });
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("routes completion only through a registered workspace and rejects unsafe writes", async () => {
		const home = await mkdtemp(path.join(os.tmpdir(), "pi-completion-bridge-"));
		const project = path.join(home, "project");
		vi.stubEnv("PI_STUDENT_HOME", home);
		await mkdir(path.join(home, "projects"));
		await mkdir(project);
		await writeFile(path.join(home, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "wks_test", cwd: project }]));
		const server = createEcosystemBridgeServer(project, home);
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const headers = { Origin: "http://127.0.0.1:6767", "X-Pi-Student": "ecosystem", "Content-Type": "application/json" };
		try {
			expect((await fetch(base + "/editor-completion/models", { headers })).status).toBe(400);
			const response = await fetch(base + "/editor-completion/models?workspaceId=wks_test", { headers });
			expect(response.status).toBe(200);
			expect(Array.isArray((await response.json()).models)).toBe(true);
			expect((await fetch(base + "/editor-completion?workspaceId=wks_test", { method: "POST", body: "{}" })).status).toBe(403);
			const unsafe = await fetch(base + "/editor-completion?workspaceId=wks_test", { method: "POST", headers, body: JSON.stringify({ filename: "../outside.ts", content: "hello", cursor: 5, model: "auto" }) });
			expect(unsafe.status).toBe(403);
		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			vi.unstubAllEnvs();
			await rm(home, { recursive: true, force: true });
		}
	});
});
