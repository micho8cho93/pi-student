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
});
