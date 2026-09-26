import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";
import { buildPaseoConfig, readAndValidatePaseoConfig, validatePaseoConfig, writePaseoConfig } from "@pi-student/paseo-adapter/config";
import { launchPaseoGui, parsePaseoStatus, type PaseoCommandResult } from "@pi-student/paseo-adapter/launcher";
import { patchPaseoWebUi } from "@pi-student/paseo-adapter/web-ui";
import { patchPaseoDictationTimeout } from "@pi-student/paseo-adapter/dictation-timeout-patch";

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-student-paseo-"));
	const paths = getInstallationPaths({ PI_STUDENT_HOME: root });
	await mkdir(path.dirname(paths.paseoExecutable), { recursive: true });
	await mkdir(paths.bin, { recursive: true });
	await writeFile(paths.paseoExecutable, "#!/bin/sh\n", { mode: 0o755 });
	await writeFile(paths.runtimeLauncher, "#!/bin/sh\n", { mode: 0o755 });
	await chmod(paths.paseoExecutable, 0o755);
	await chmod(paths.runtimeLauncher, 0o755);
	return { root, paths };
}

const result = (stdout = "", status = 0, stderr = ""): PaseoCommandResult => ({ stdout, stderr, status });

describe("Paseo integration", () => {
	it("allows slow on-device dictation to return its final transcript", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-student-paseo-dictation-"));
		const executable = path.join(root, "node_modules", ".bin", "paseo");
		const manager = path.join(root, "node_modules", "@getpaseo", "server", "dist", "server", "server", "dictation", "dictation-stream-manager.js");
		try {
			await mkdir(path.dirname(executable), { recursive: true });
			await mkdir(path.dirname(manager), { recursive: true });
			await writeFile(manager, "const DEFAULT_DICTATION_FINAL_TIMEOUT_MS = 10000;\n");
			expect(await patchPaseoDictationTimeout(executable)).toBe(true);
			expect(await readFile(manager, "utf8")).toContain("DEFAULT_DICTATION_FINAL_TIMEOUT_MS = 120000");
			expect(await patchPaseoDictationTimeout(executable)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("builds one locked-down Pi Student provider around the shared runtime", async () => {
		const { root, paths } = await fixture();
		try {
			const config = await buildPaseoConfig(paths);
			expect(config.agents?.providers?.["pi-student"]).toMatchObject({
				extends: "pi",
				label: "Pi Student",
				command: [paths.runtimeLauncher],
				paseoTools: { enabled: false },
			});
			expect(config.daemon?.mcp).toEqual({ enabled: false, injectIntoAgents: false });
			expect(config.daemon?.terminalProfiles).toEqual([]);
			expect(config.agents?.providers?.codex?.enabled).toBe(false);
			expect(validatePaseoConfig(config, paths)).toEqual({ ok: true });
			await writePaseoConfig(paths);
			expect(await readAndValidatePaseoConfig(paths)).toEqual({ ok: true });
			expect(JSON.parse(await readFile(paths.paseoConfig, "utf8"))).toEqual(config);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("adds the student web UI shell restrictions once", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-student-paseo-ui-"));
		const executable = path.join(root, "node_modules", ".bin", "paseo");
		const webUi = path.join(root, "node_modules", "@getpaseo", "server", "dist", "server", "web-ui");
		try {
			await mkdir(path.dirname(executable), { recursive: true });
			await mkdir(webUi, { recursive: true });
			await writeFile(path.join(webUi, "index.html"), "<!doctype html><html><head></head><body></body></html>");
			expect(await patchPaseoWebUi(executable)).toBe(true);
			const patched = await readFile(path.join(webUi, "index.html"), "utf8");
			expect(patched).toContain('data-pi-student-ui="student-v13"');
			expect(patched).toContain('data-pi-student-flowchart="v1"');
			expect(patched).toContain('localStorage.removeItem(connectionRegistryKey)');
			expect(patched).toContain("workspace-new-tab-browser");
			expect(patched).toContain('autoExpandReasoning: false');
			expect(patched).toContain('toolCallDetailLevel: "detailed"');
			expect(patched).toContain('compactToolCalls: false');
			expect(patched).toContain("http://127.0.0.1:6769");
			expect(patched).toContain('sidebar-project-workspace-list-scroll');
			expect(patched).toContain('requestUrl.searchParams.set("workspaceId", workspaceId)');
			expect(patched).toContain('const main = findMainArea()');
			expect(patched).toContain('pageMount.id = "pi-student-ecosystem-page"');
			expect(patched).toContain('pageRoot.appendChild(renderPanel())');
			expect(patched).not.toContain('wrap.appendChild(renderPanel())');
			expect(patched).toContain('.panel{box-sizing:border-box;width:min(100%,880px)');
			expect(patched).toContain('.action.success{background:#16a34a');
			expect(patched).toContain('.action.danger{background:#dc2626');
			expect(patched).toContain('actionButton("Publish", publishFromGui)');
			expect(patched).toContain('actionButton("Publish", publishFromGui, "success")');
			expect(patched).toContain('actionButton("Remove site", () => removeSiteFromGui(project), "danger")');
			expect(patched).not.toContain('width:min(520px,90vw)');
			const script = patched.match(/<script data-pi-student-ui="student-v13">([\s\S]*?)<\/script>/)?.[1];
			expect(script).toBeTruthy();
			expect(() => new Function(script!)).not.toThrow();
			expect(await patchPaseoWebUi(executable)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("replaces older shell scripts instead of installing duplicate handlers", async () => {
		const { root, paths } = await fixture();
		const index = path.resolve(path.dirname(paths.paseoExecutable), "../../node_modules/@getpaseo/server/dist/server/web-ui/index.html");
		try {
			await mkdir(path.dirname(index), { recursive: true });
			await writeFile(index, '<html><head><script data-pi-student-ui="student-v3">old()</script><script data-pi-student-ui="student-v4">old()</script></head></html>');
			await patchPaseoWebUi(paths.paseoExecutable);
			const html = await readFile(index, "utf8");
			expect(html.match(/data-pi-student-ui=/g)).toHaveLength(1);
			expect(html).not.toContain("old()");
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("restarts when speech changes cannot be hot reloaded", async () => {
		const { root, paths } = await fixture();
		const commands: string[][] = [];
		try {
			await launchPaseoGui({ paths, run(args) {
				commands.push(args);
				if (args[0] === "status") return result(JSON.stringify({ localDaemon: "running", connectedDaemon: "reachable" }));
				if (args[0] === "reload") return result(JSON.stringify({ restartRequiredPaths: ["features.dictation.enabled"] }));
				return result();
			}, waitForReady: async () => true, open: () => {} });
			expect(commands).toContainEqual(["daemon", "restart", "--web-ui", "--no-relay", "--no-mcp"]);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("restarts a running daemon when the student web UI changes", async () => {
		const { root, paths } = await fixture();
		const commands: string[][] = [];
		const index = path.resolve(path.dirname(paths.paseoExecutable), "../../node_modules/@getpaseo/server/dist/server/web-ui/index.html");
		try {
			await mkdir(path.dirname(index), { recursive: true });
			await writeFile(index, "<!doctype html><html><head></head><body></body></html>");
			await launchPaseoGui({ paths, run(args) {
				commands.push(args);
				if (args[0] === "status") return result(JSON.stringify({ localDaemon: "running", connectedDaemon: "reachable" }));
				if (args[0] === "reload") return result(JSON.stringify({ restartRequiredPaths: [] }));
				return result();
			}, waitForReady: async () => true, open: () => {} });
			expect(commands).toContainEqual(["daemon", "restart", "--web-ui", "--no-relay", "--no-mcp"]);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("reuses a healthy daemon instead of starting a duplicate", async () => {
		const { root, paths } = await fixture();
		const commands: string[][] = [];
		const opened = vi.fn();
		try {
			await launchPaseoGui({
				paths,
				run(args) {
					commands.push(args);
					if (args[0] === "status") return result(JSON.stringify({ localDaemon: "running", connectedDaemon: "reachable", providers: [{ provider: "pi-student", label: "Pi Student" }] }));
					return result();
				},
				waitForReady: async () => true,
				open: opened,
			});
			expect(commands.some((args) => args.includes("start"))).toBe(false);
			expect(commands.some((args) => args[0] === "reload")).toBe(true);
			expect(opened).toHaveBeenCalledWith("http://127.0.0.1:6767");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses the checked-out Paseo and shared runtime during local development", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-student-paseo-dev-"));
		const paths = getInstallationPaths({ PI_STUDENT_HOME: root });
		const runtimeEntry = path.join(root, "client-runtime.js");
		const commands: string[][] = [];
		vi.stubEnv("PI_STUDENT_DEV", "1");
		try {
			await writeFile(runtimeEntry, "#!/usr/bin/env node\n");
			await launchPaseoGui({
				paths,
				runtimeEntry,
				run(args) { commands.push(args); return args[0] === "status" ? result("", 1) : result(); },
				waitForReady: async () => true,
				open: () => {},
			});
			expect(commands).toContainEqual(["daemon", "start", "--web-ui", "--no-relay", "--no-mcp"]);
			expect(await readFile(paths.runtimeLauncher, "utf8")).toContain(runtimeEntry);
		} finally {
			vi.unstubAllEnvs();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("starts a stopped daemon and reports startup and port conflicts clearly", async () => {
		const { root, paths } = await fixture();
		try {
			const commands: string[][] = [];
			await launchPaseoGui({
				paths,
				run(args) { commands.push(args); return args[0] === "status" ? result(JSON.stringify({ localDaemon: "stopped", connectedDaemon: "unreachable" })) : result(); },
				waitForReady: async () => true,
				open: () => {},
			});
			expect(commands).toContainEqual(["daemon", "start", "--web-ui", "--no-relay", "--no-mcp"]);

			await expect(launchPaseoGui({
				paths,
				run: args => args[0] === "status"
					? result(JSON.stringify({ localDaemon: "stopped", connectedDaemon: "reachable" }))
					: result("", 1, "listen EADDRINUSE 127.0.0.1:6767"),
				waitForReady: async () => true,
				open: () => {},
			})).rejects.toThrow(/EADDRINUSE/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("handles missing Paseo, invalid config, and an RPC process exit", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-student-paseo-missing-"));
		const paths = getInstallationPaths({ PI_STUDENT_HOME: root });
		try {
			await expect(launchPaseoGui({ paths })).rejects.toThrow(/Paseo is not installed/);
			const config = await buildPaseoConfig(paths);
			config.agents!.providers!["pi-student"]!.command = ["/wrong/runtime"];
			expect(validatePaseoConfig(config, paths)).toMatchObject({ ok: false });

			await mkdir(path.dirname(paths.paseoExecutable), { recursive: true });
			await mkdir(paths.bin, { recursive: true });
			await writeFile(paths.paseoExecutable, "#!/bin/sh\n", { mode: 0o755 });
			await writeFile(paths.runtimeLauncher, "#!/bin/sh\n", { mode: 0o755 });
			await expect(launchPaseoGui({
				paths,
				run: args => args[0] === "status" ? result("", 1) : result("", 1, "Pi Student RPC process exited unexpectedly"),
				waitForReady: async () => false,
				open: () => {},
			})).rejects.toThrow(/RPC process exited unexpectedly/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("parses structured daemon status without trusting malformed output", () => {
		expect(parsePaseoStatus('{"localDaemon":"running"}')).toMatchObject({ localDaemon: "running" });
		expect(parsePaseoStatus("not json")).toBeUndefined();
	});
});
