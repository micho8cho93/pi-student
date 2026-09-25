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
	} })).rejects.toThrow(/capabilities that are unavailable/);
	expect(runtime.isRunning()).toBe(false);
	expect(manager.getEnvironmentState().status).toBe("unsupported");
});

it("validates a complete Gondolin policy before mutating the current policy", async () => {
	const runtime = new GondolinRuntime();
	await runtime.configure({ mode: "gondolin", internetAllowed: true, blockedHosts: ["Example.org."] });
	await expect(runtime.configure({ mode: "gondolin", internetAllowed: false, blockedHosts: ["not a host"] })).rejects.toThrow(/Invalid sandbox blocked site/);
	expect((runtime as unknown as { maxInternetAllowed: boolean }).maxInternetAllowed).toBe(true);
	expect((runtime as unknown as { internetAllowed: boolean }).internetAllowed).toBe(true);
	expect((runtime as unknown as { blockedHosts: string[] }).blockedHosts).toEqual(["example.org"]);
});

it("does not allow a managed class to switch a running host backend into Gondolin by metadata alone", async () => {
	const { HostRuntime } = await import("../src/host-runtime.js");
	const manager = new SandboxManager(undefined, { runtime: new HostRuntime() });
	await expect(manager.configure({ mode: "gondolin", internetAllowed: false })).rejects.toThrow(/not supported by the active sandbox provider/);
});

it("never widens organization network denial when project policy changes", async () => {
	const runtime = new GondolinRuntime();
	await runtime.configure({ mode: "gondolin", internetAllowed: false });
	runtime.setInternetAllowed(true);
	expect((runtime as unknown as { internetAllowed: boolean }).internetAllowed).toBe(false);
});
