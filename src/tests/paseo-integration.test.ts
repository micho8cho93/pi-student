import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getInstallationPaths } from "../install/paths.js";
import { buildPaseoConfig, readAndValidatePaseoConfig, validatePaseoConfig, writePaseoConfig } from "../integrations/paseo/config.js";
import { launchPaseoGui, parsePaseoStatus, type PaseoCommandResult } from "../integrations/paseo/launcher.js";
import { patchPaseoWebUi } from "../integrations/paseo/web-ui.js";

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
			expect(patched).toContain('data-pi-student-ui="student-v2"');
			expect(patched).toContain("workspace-new-tab-browser");
			expect(await patchPaseoWebUi(executable)).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
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
		const commands: string[][] = [];
		vi.stubEnv("PI_STUDENT_DEV", "1");
		try {
			await launchPaseoGui({
				paths,
				run(args) { commands.push(args); return args[0] === "status" ? result("", 1) : result(); },
				waitForReady: async () => true,
				open: () => {},
			});
			expect(commands).toContainEqual(["daemon", "start", "--web-ui", "--no-relay", "--no-mcp"]);
			expect(await readFile(paths.runtimeLauncher, "utf8")).toContain(path.resolve("dist", "cli.js"));
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
