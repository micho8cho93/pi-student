import { expect, it } from "vitest";
import { GondolinRuntime } from "../src/gondolin-runtime.js";
import { SandboxManager } from "@pi-student/sandbox/sandbox-manager";

it("fails closed on a managed profile instead of mounting host resources or installing packages", async () => {
	const runtime = new GondolinRuntime();
	const manager = new SandboxManager(undefined, { runtime });
	await expect(manager.configure({ mode: "gondolin", profile: {
		id: "p", organizationId: "o", name: "Node", version: 1, runtime: "node", runtimeVersion: "22",
		packages: [], imageDigest: `sha256:${"a".repeat(64)}`, buildStatus: "ready", datasets: [],
		network: { allowed: false, allowedHosts: [] }, limits: { cpuMillis: 1000, memoryMiB: 1024, storageMiB: 2048, timeoutSeconds: 120 }, metadata: {},
	} })).rejects.toThrow(/cannot enforce managed profiles/);
	expect(runtime.isRunning()).toBe(false);
});

it("does not allow a managed class to switch a running host backend into Gondolin by metadata alone", async () => {
	const { HostRuntime } = await import("../src/host-runtime.js");
	const manager = new SandboxManager(undefined, { runtime: new HostRuntime() });
	await expect(manager.configure({ mode: "gondolin", internetAllowed: false })).rejects.toThrow(/mode does not match/);
});

it("never widens organization network denial when project policy changes", async () => {
	const runtime = new GondolinRuntime();
	await runtime.configure({ mode: "gondolin", internetAllowed: false });
	runtime.setInternetAllowed(true);
	expect((runtime as unknown as { internetAllowed: boolean }).internetAllowed).toBe(false);
});
