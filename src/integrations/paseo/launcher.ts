import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { getInstallationPaths, type InstallationPaths } from "../../install/paths.js";
import { openBrowser } from "../../teacher/open-browser.js";
import { PASEO_URL, writePaseoConfig } from "./config.js";
import { PASEO_VOZ_BRIDGE_PORT } from "./voz-bridge.js";
import { githubHelperDirectory } from "../../publishing/github-runtime.js";
import { patchPaseoGitState } from "./git-state-patch.js";
import { patchPaseoWebUi } from "./web-ui.js";
import { ECOSYSTEM_BRIDGE_PORT } from "../../publishing/ecosystem-bridge.js";
import { patchPaseoDictationTimeout } from "./dictation-timeout-patch.js";

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
	if (isDevelopmentMode()) await ensureDevelopmentRuntimeLauncher(paths);
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
		await ensureVozBridge(paths);
		await ensureEcosystemBridge(paths, ECOSYSTEM_BRIDGE_PORT);
	}
	await writePaseoConfig(paths);
	await patchPaseoWebUi(paseoExecutable, ECOSYSTEM_BRIDGE_PORT);
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
		if (gitServicePatched || dictationTimeoutPatched || changes.restartRequiredPaths?.length) {
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

async function ensureVozBridge(paths: InstallationPaths): Promise<void> {
	if (await isVozBridgeRunning()) return;
	const entry = await findRuntimeEntry(paths);
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

async function ensureEcosystemBridge(paths: InstallationPaths, port: number): Promise<void> {
	if (await isEcosystemBridgeRunning(port)) return;
	const entry = await findRuntimeEntry(paths);
	if (!entry) throw new Error("Pi Student could not start its GitHub and deployment bridge because the runtime entrypoint is missing.");
	const child = spawn(process.execPath, [entry, "ecosystem-bridge"], {
		cwd: process.cwd(),
		env: { ...process.env, PASEO_HOME: paths.paseoHome, PI_STUDENT_ECOSYSTEM_BRIDGE_PORT: String(port) },
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
		const body = await response.json() as { provider?: unknown; multiProject?: unknown };
		return body.provider === "pi-student-ecosystem" && body.multiProject === true;
	} catch { return false; }
}

async function findRuntimeEntry(paths: InstallationPaths): Promise<string | undefined> {
	for (const candidate of [path.join(paths.app, "dist", "cli.js"), path.resolve(process.cwd(), "dist", "cli.js")]) {
		try {
			await access(candidate, constants.R_OK);
			return candidate;
		} catch {
			// Try the next development/installed location.
		}
	}
	return undefined;
}

async function resolvePaseoExecutable(paths: InstallationPaths): Promise<string | undefined> {
	if (await isExecutable(paths.paseoExecutable)) return paths.paseoExecutable;
	if (!isDevelopmentMode()) return undefined;
	const localExecutable = path.resolve(process.cwd(), "node_modules", ".bin", "paseo");
	return await isExecutable(localExecutable) ? localExecutable : undefined;
}

async function ensureDevelopmentRuntimeLauncher(paths: InstallationPaths): Promise<void> {
	if (await isExecutable(paths.runtimeLauncher)) return;
	const entry = path.resolve(process.cwd(), "dist", "cli.js");
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
