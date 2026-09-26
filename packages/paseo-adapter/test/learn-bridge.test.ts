import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createEcosystemBridgeServer } from "@pi-student/paseo-adapter/ecosystem-bridge";
import { LearnSettingsStore } from "@pi-student/education/settings";

afterEach(() => vi.unstubAllEnvs());
describe("Learn GUI bridge", () => {
	it("updates only the selected session, rejects foreign origins and malformed writes, and shares the runtime store", async () => {
		const home = await mkdtemp(path.join(os.tmpdir(), "pi-learn-bridge-"));
		vi.stubEnv("PI_STUDENT_HOME", home);
		await mkdir(path.join(home, "projects"), { recursive: true });
		await mkdir(path.join(home, "agents", "tmp-example"), { recursive: true });
		await writeFile(path.join(home, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "wks_test", cwd: "/tmp/example" }]));
		await writeFile(path.join(home, "agents", "tmp-example", "agent-1.json"), JSON.stringify({ id: "agent-1", provider: "pi-student", cwd: "/tmp/example", workspaceId: "wks_test", runtimeInfo: { sessionId: "pi-one" } }));
		const server = createEcosystemBridgeServer("/tmp/example", home);
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/learn-mode?workspaceId=wks_test&agentId=agent-1`;
		const headers = { "Origin": "http://127.0.0.1:6767", "X-Pi-Student": "ecosystem", "Content-Type": "application/json" };
		try {
			expect(await (await fetch(base, { headers })).json()).toEqual({ learnMode: false });
			const response = await fetch(base, { method: "POST", headers, body: JSON.stringify({ learnMode: true }) });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ learnMode: true });
			expect(await new LearnSettingsStore().read("/tmp/example", "pi-one")).toBe(true);
			expect(await new LearnSettingsStore().read("/tmp/example", "pi-two")).toBe(false);
			expect((await fetch(base, { method: "POST", headers, body: '{"learnMode":"yes"}' })).status).toBe(400);
			expect((await fetch(base, { method: "POST", headers: { ...headers, Origin: "https://untrusted.example" }, body: '{"learnMode":false}' })).status).toBe(403);
			expect((await fetch(base, { method: "POST", body: '{"learnMode":false}' })).status).toBe(403);
			await new LearnSettingsStore().write("/tmp/example", "pi-one", false);
			expect(await (await fetch(base, { headers })).json()).toEqual({ learnMode: false });
		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			await rm(home, { recursive: true, force: true });
		}
	});

	it("shares a GUI Learn toggle with Code, Map and Terminal for that conversation and project only", async () => {
		const home = await mkdtemp(path.join(os.tmpdir(), "pi-learn-surfaces-"));
		vi.stubEnv("PI_STUDENT_HOME", home);
		const [a, b] = [path.join(home, "project-a"), path.join(home, "project-b")];
		await mkdir(path.join(home, "projects"), { recursive: true });
		for (const [project, workspaceId, agentId] of [[a, "wks_a", "agent-a"], [b, "wks_b", "agent-b"]]) {
			await mkdir(project, { recursive: true });
			const agents = path.join(home, "agents", project.replace(/^\//, "").replace(/[\\/]/g, "-"));
			await mkdir(agents, { recursive: true });
			await writeFile(path.join(agents, `${agentId}.json`), JSON.stringify({ id: agentId, provider: "pi-student", cwd: project, workspaceId, runtimeInfo: { sessionId: `pi-${agentId}` } }));
		}
		await writeFile(path.join(home, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "wks_a", cwd: a }, { workspaceId: "wks_b", cwd: b }]));
		const server = createEcosystemBridgeServer(a, home);
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const headers = { "Origin": "http://127.0.0.1:6767", "X-Pi-Student": "ecosystem", "Content-Type": "application/json" };
		const activity = async (workspaceId: string, agentId?: string) => (await fetch(`${base}/workspace-activity?workspaceId=${workspaceId}${agentId ? `&agentId=${agentId}` : ""}`, { headers })).json();
		const report = (body: object) => fetch(`${base}/workspace-events?workspaceId=wks_a`, { method: "POST", headers, body: JSON.stringify(body) });
		try {
			expect((await activity("wks_a")).scaffolding.enabled).toBe(false);
			const toggled = await fetch(`${base}/learn-mode?workspaceId=wks_a&agentId=agent-a`, { method: "POST", headers, body: JSON.stringify({ learnMode: true }) });
			expect(toggled.status).toBe(200);
			// Every surface reads the same profile after its own activity.
			for (const event of [{ type: "file.opened", file: "src/app.ts" }, { type: "flowchart.node_selected", id: "n1", label: "Start" },
				{ type: "terminal.command_finished", command: "npm test", exitCode: 1, summary: "Error: boom" }]) {
				expect((await report(event)).status).toBe(202);
				const state = await activity("wks_a", "agent-a");
				expect(state.learn.enabled).toBe(true);
				expect(state.scaffolding).toMatchObject({ enabled: true, flowchart: { detail: "educational" }, editor: { autocomplete: "concise" },
					terminal: { onFailure: "explain-first", blocksCommands: false } });
			}
			// Learn is session state: surfaces not following that conversation, and other projects, keep their own setting.
			expect((await activity("wks_a")).scaffolding.enabled).toBe(false);
			expect((await activity("wks_b", "agent-b")).scaffolding.enabled).toBe(false);
			expect((await activity("wks_b")).learn).toBeUndefined();
		} finally {
			await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			await rm(home, { recursive: true, force: true });
		}
	});
});
