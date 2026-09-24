import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { getInstallationPaths, type InstallationPaths } from "@pi-student/shared/installation-paths";
import { openBrowser } from "@pi-student/shared/open-browser";
import { PASEO_URL, writePaseoConfig } from "./config.js";
import { PASEO_VOZ_BRIDGE_PORT } from "./voz-bridge.js";
import { githubHelperDirectory } from "@pi-student/publishing/github-runtime";
import { patchPaseoGitState } from "./git-state-patch.js";
import { patchPaseoWebUi } from "./web-ui.js";
import { ECOSYSTEM_BRIDGE_PORT } from "./ecosystem-bridge.js";
import { patchPaseoDictationTimeout } from "./dictation-timeout-patch.js";

const require = createRequire(import.meta.url);

interface PaseoStatus {
	localDaemon?: string;
	connectedDaemon?: string;
	providers?: Array<{ provider?: string; label?: string; path?: string | null }>;
}

export interface PaseoCommandResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type PaseoCommandRunner = (args: string[], env: NodeJS.ProcessEnv) => PaseoCommandResult;

export interface LaunchPaseoOptions {
	paths?: InstallationPaths;
	runtimeEntry?: string;
	run?: PaseoCommandRunner;
	open?: (url: string) => void;
	waitForReady?: (url: string) => Promise<boolean>;
}

export async function launchPaseoGui(options: LaunchPaseoOptions = {}): Promise<void> {
	const paths = options.paths ?? getInstallationPaths();
	const paseoExecutable = await resolvePaseoExecutable(paths);
	if (!paseoExecutable) {
		throw new Error("Pi Student GUI could not start because Paseo is not installed.\n\nRun `npm install` for local development, or rerun the Pi Student installer.");
	}
	if (isDevelopmentMode()) await ensureDevelopmentRuntimeLauncher(paths, options.runtimeEntry);
	const run = options.run ?? ((args, env) => normalizeSpawnResult(spawnSync(paseoExecutable, args, {
		encoding: "utf8",
		env,
		windowsHide: true,
	})));
	try {
		await access(paths.runtimeLauncher, constants.X_OK);
	} catch {
		throw new Error("Pi Student GUI could not find the shared runtime.\n\nRe-run the Pi Student installer.");
	}

	if (!options.run) {
		await ensureVozBridge(paths, options.runtimeEntry);
		await ensureEcosystemBridge(paths, ECOSYSTEM_BRIDGE_PORT, options.runtimeEntry);
	}
	await writePaseoConfig(paths);
	const webUiPatched = await patchPaseoWebUi(paseoExecutable, ECOSYSTEM_BRIDGE_PORT);
	const gitServicePatched = await patchPaseoGitState(paseoExecutable);
	const dictationTimeoutPatched = await patchPaseoDictationTimeout(paseoExecutable);
	const env = { ...process.env, PI_STUDENT_HOME: paths.root, PASEO_HOME: paths.paseoHome,
		PATH: `${process.env.PATH ?? ""}${path.delimiter}${githubHelperDirectory({ PI_STUDENT_HOME: paths.root })}` };
	const statusResult = run(["status", "--json", "--no-color"], env);
	const status = parsePaseoStatus(statusResult.stdout);
	const ready = statusResult.status === 0 && status?.localDaemon === "running" && status.connectedDaemon === "reachable";
	if (ready) {
		const reload = run(["reload", "--json", "--no-color"], env);
		if (reload.status !== 0) throw new Error(`Pi Student could not reload Paseo configuration: ${conciseError(reload.stderr || reload.stdout)}`);
		const changes = JSON.parse(reload.stdout || "{}") as { restartRequiredPaths?: string[] };
		if (webUiPatched || gitServicePatched || dictationTimeoutPatched || changes.restartRequiredPaths?.length) {
			const restart = run(["daemon", "restart", "--web-ui", "--no-relay", "--no-mcp"], env);
			if (restart.status !== 0) throw new Error(`Pi Student could not restart Paseo to apply configuration: ${conciseError(restart.stderr || restart.stdout)}`);
		}
	} else {
		const start = run(["daemon", "start", "--web-ui", "--no-relay", "--no-mcp"], env);
		if (start.status !== 0) {
			const detail = conciseError(start.stderr || start.stdout);
			throw new Error(`Pi Student GUI could not start Paseo.${detail ? `\n\n${detail}` : ""}\n\nTry:\n  pi-student doctor --verbose`);
		}
	}

	const waitForReady = options.waitForReady ?? defaultWaitForReady;
	if (!await waitForReady(PASEO_URL)) {
		throw new Error(`Paseo did not become ready at ${PASEO_URL}.\n\nTry:\n  pi-student doctor --verbose`);
	}
	(options.open ?? openBrowser)(PASEO_URL);
	process.stdout.write(`Pi Student GUI is ready at ${PASEO_URL}\n`);
}

async function ensureVozBridge(paths: InstallationPaths, runtimeEntry?: string): Promise<void> {
	if (await isVozBridgeRunning()) return;
	const entry = await findRuntimeEntry(runtimeEntry);
	if (!entry) throw new Error("Pi Student could not start the Voz bridge because its runtime entrypoint is missing.");
	const child = spawn(process.execPath, [entry, "voz-bridge"], {
		env: {
			...process.env,
			DESERTANT_HOME: path.join(paths.root, "runtime", "voz"),
			PATH: `${path.join(paths.root, "runtime", "voz")}:${process.env.PATH ?? ""}`,
			PI_STUDENT_VOZ_BRIDGE_PORT: String(PASEO_VOZ_BRIDGE_PORT),
		},
		stdio: "ignore",
		detached: true,
		windowsHide: true,
	});
	child.unref();
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (await isVozBridgeRunning()) return;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error("Pi Student could not start the local Voz transcription bridge.");
}

async function ensureEcosystemBridge(paths: InstallationPaths, port: number, runtimeEntry?: string): Promise<void> {
	if (await isEcosystemBridgeRunning(port)) {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
		const health = await response.json() as { learnMode?: boolean; flowchart?: boolean };
		if (health.learnMode !== true || health.flowchart !== true) throw new Error("An older Pi Student background bridge is still running. Stop the existing pi-student ecosystem-bridge process and relaunch the GUI to enable the current student features.");
		return;
	}
	const entry = await findRuntimeEntry(runtimeEntry);
	if (!entry) throw new Error("Pi Student could not start its GitHub and deployment bridge because the runtime entrypoint is missing.");
	const child = spawn(process.execPath, [entry, "ecosystem-bridge"], {
		cwd: process.cwd(),
		env: { ...process.env, PI_STUDENT_HOME: paths.root, PASEO_HOME: paths.paseoHome, PI_STUDENT_ECOSYSTEM_BRIDGE_PORT: String(port) },
		stdio: "ignore",
		detached: true,
		windowsHide: true,
	});
	child.unref();
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (await isEcosystemBridgeRunning(port)) return;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	throw new Error("Pi Student could not start its GitHub and deployment bridge.");
}

async function isVozBridgeRunning(): Promise<boolean> {
	try {
		const response = await fetch("http://127.0.0.1:6768/health", { signal: AbortSignal.timeout(150) });
		if (!response.ok) return false;
		const body = await response.json() as { provider?: unknown; local?: unknown };
		return body.provider === "voz" && body.local === true;
	} catch {
		return false;
	}
}

async function isEcosystemBridgeRunning(port: number): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(150) });
		if (!response.ok) return false;
		const body = await response.json() as { provider?: unknown; multiProject?: unknown; learnMode?: unknown };
		return body.provider === "pi-student-ecosystem" && body.multiProject === true;
	} catch { return false; }
}

async function findRuntimeEntry(runtimeEntry?: string): Promise<string | undefined> {
	if (!runtimeEntry) return undefined;
	try {
		await access(runtimeEntry, constants.R_OK);
		return runtimeEntry;
	} catch {
		return undefined;
	}
}

async function resolvePaseoExecutable(paths: InstallationPaths): Promise<string | undefined> {
	if (await isExecutable(paths.paseoExecutable)) return paths.paseoExecutable;
	if (!isDevelopmentMode()) return undefined;
	let localExecutable: string;
	try {
		const cliPackage = require.resolve("@getpaseo/cli/package.json");
		localExecutable = path.resolve(path.dirname(cliPackage), "..", "..", ".bin", "paseo");
	} catch {
		return undefined;
	}
	return await isExecutable(localExecutable) ? localExecutable : undefined;
}

async function ensureDevelopmentRuntimeLauncher(paths: InstallationPaths, runtimeEntry?: string): Promise<void> {
	if (await isExecutable(paths.runtimeLauncher)) return;
	if (!runtimeEntry) throw new Error("Pi Student GUI requires the client runtime entrypoint during local development.");
	const entry = runtimeEntry;
	try {
		await access(entry, constants.R_OK);
	} catch {
		throw new Error("Pi Student GUI could not find the development build. Run `npm start` so it can build the shared runtime first.");
	}
	await mkdir(path.dirname(paths.runtimeLauncher), { recursive: true, mode: 0o700 });
	const launcher = `#!/bin/sh
set -eu
exec ${shellQuote(process.execPath)} ${shellQuote(entry)} runtime "$@"
`;
	await writeFile(paths.runtimeLauncher, launcher, { mode: 0o755 });
	await chmod(paths.runtimeLauncher, 0o755);
}

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function isDevelopmentMode(): boolean {
	return process.env.PI_STUDENT_DEV === "1";
}

function shellQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function parsePaseoStatus(stdout: string): PaseoStatus | undefined {
	try {
		const value = JSON.parse(stdout) as PaseoStatus;
		return value && typeof value === "object" ? value : undefined;
	} catch {
		return undefined;
	}
}

async function defaultWaitForReady(url: string): Promise<boolean> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(750) });
			if (response.ok) return true;
		} catch {
			// The detached daemon normally needs a short moment to bind and serve the UI.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	return false;
}

function normalizeSpawnResult(result: SpawnSyncReturns<string>): PaseoCommandResult {
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? result.error?.message ?? "",
	};
}

function conciseError(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 400);
}
