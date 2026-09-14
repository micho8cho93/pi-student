import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { getInstallationPaths } from "./paths.js";
import { appendDiagnosticLog } from "./logging.js";
import { isSandboxImageAvailable, runSandboxHealthCheck } from "../sandbox/health-check.js";
import { normalizePlatform } from "../sandbox/platform.js";
import { readRuntimeMetadata } from "../sandbox/runtime-metadata.js";
import { findExecutable, resolveSandboxRuntime } from "../sandbox/runtime.js";
import { readAndValidatePaseoConfig } from "../integrations/paseo/config.js";

interface Check {
	label: string;
	ok: boolean;
	detail?: string;
}

export async function runDoctor(options: { verbose?: boolean; cwd?: string } = {}): Promise<boolean> {
	const paths = getInstallationPaths();
	const groups: Array<{ name: string; checks: Check[] }> = [];
	const application: Check[] = [];
	const sandbox: Check[] = [];
	const workspace: Check[] = [];
	const configuration: Check[] = [];
	const gui: Check[] = [];
	groups.push({ name: "Application", checks: application }, { name: "Sandbox", checks: sandbox }, { name: "Workspace", checks: workspace }, { name: "Configuration", checks: configuration });

	application.push(await fileCheck("Pi Student installed", path.join(paths.app, "dist", "cli.js"), options.verbose));
	const launcher = await findExecutable("pi-student");
	application.push({ label: "Launcher available", ok: Boolean(launcher), detail: launcher ?? `not on PATH (expected ${paths.launcher})` });
	application.push(await fileCheck("Shared runtime launcher available", paths.runtimeLauncher, options.verbose));

	try {
		const resolved = await resolveSandboxRuntime();
		application.push({ label: "Runtime available", ok: true, detail: `${resolved.backend}: ${resolved.executablePath}` });
	} catch (error) {
		application.push({ label: "Runtime available", ok: false, detail: errorMessage(error) });
	}

	sandbox.push({ label: "Gondolin installed", ok: true, detail: "@earendil-works/gondolin" });
	sandbox.push({ label: "Guest image available", ok: isSandboxImageAvailable(), detail: isSandboxImageAvailable() ? undefined : "image has not been downloaded" });
	try {
		const result = await runSandboxHealthCheck();
		sandbox.unshift({ label: `Backend: ${result.runtime.backend}`, ok: true, detail: result.runtime.executablePath });
		const fallbackDetail = result.fallbackFailures.length ? `; fallback reason: ${result.fallbackFailures.join(" ")}` : "";
		sandbox.push({ label: "Sandbox boot successful", ok: result.bootSuccessful, detail: `${result.runtime.backend} smoke test passed${fallbackDetail}` });
		const imageCheck = sandbox.find((check) => check.label === "Guest image available");
		if (imageCheck) {
			imageCheck.ok = true;
			imageCheck.detail = undefined;
		}
	} catch (error) {
		const detail = errorMessage(error);
		sandbox.unshift({ label: "Backend available", ok: false, detail });
		sandbox.push({ label: "Sandbox boot successful", ok: false, detail });
		await appendDiagnosticLog("doctor", detail).catch(() => undefined);
	}

	workspace.push(await fileCheck("Working directory accessible", options.cwd ?? process.cwd(), options.verbose));
	const metadata = await readRuntimeMetadata();
	configuration.push({
		label: "Configuration valid",
		ok: Boolean(metadata),
		detail: metadata ? `${metadata.platform}, ${metadata.backend}, verified ${metadata.verifiedAt}` : `missing or invalid ${paths.runtimeMetadata}`,
	});

	if (await isAccessible(paths.paseoExecutable) || await isAccessible(paths.paseoConfig)) {
		groups.push({ name: "GUI", checks: gui });
		gui.push(await fileCheck("Paseo installed", paths.paseoExecutable, options.verbose));
		const paseoConfig = await readAndValidatePaseoConfig(paths);
		gui.push({
			label: "Paseo configuration valid",
			ok: paseoConfig.ok,
			detail: paseoConfig.ok ? (options.verbose ? paths.paseoConfig : undefined) : paseoConfig.error,
		});
		gui.push(await rpcCheck(paths.runtimeLauncher, options.cwd ?? process.cwd(), paseoConfig.ok, options.verbose));
	}

	process.stdout.write("Pi Student Environment\n\n");
	for (const group of groups) {
		process.stdout.write(`${group.name}\n`);
		for (const check of group.checks) {
			const detail = options.verbose && check.detail ? ` — ${check.detail}` : "";
			process.stdout.write(`  ${check.ok ? "✓" : "✗"} ${check.label}${detail}\n`);
		}
		process.stdout.write("\n");
	}
	const ok = groups.every((group) => group.checks.every((check) => check.ok));
	process.stdout.write(ok ? "Everything looks good.\n" : "Suggested repair:\n  pi-student repair\n");
	return ok;
}

async function fileCheck(label: string, filePath: string, verbose = false): Promise<Check> {
	try {
		await access(filePath);
		return { label, ok: true, detail: verbose ? filePath : undefined };
	} catch {
		return { label, ok: false, detail: filePath };
	}
}

async function isAccessible(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function rpcCheck(runtimeLauncher: string, cwd: string, configValid: boolean, verbose = false): Promise<Check> {
	if (!configValid || !await isAccessible(runtimeLauncher)) {
		return { label: "GUI can communicate with Pi Student RPC", ok: false, detail: "runtime or Paseo configuration is unavailable" };
	}
	return new Promise((resolve) => {
		const id = `doctor-${process.pid}`;
		const child = spawn(runtimeLauncher, ["--mode", "rpc", "--no-session"], {
			cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let output = "";
		let errors = "";
		let received = false;
		let settled = false;
		const finish = (ok: boolean, detail?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve({ label: "GUI can communicate with Pi Student RPC", ok, detail: verbose ? detail : undefined });
		};
		const inspect = () => {
			for (const line of output.split("\n")) {
				try {
					const frame = JSON.parse(line) as { id?: string; type?: string; success?: boolean };
					if (frame.id === id && frame.type === "response" && frame.success === true) {
						received = true;
						child.stdin.end();
						return;
					}
				} catch {
					// Ignore incomplete lines and unrelated extension events.
				}
			}
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { output += chunk; inspect(); });
		child.stderr.on("data", (chunk: string) => { errors += chunk; });
		child.on("error", (error) => finish(false, error.message));
		child.on("exit", (code) => finish(received && code === 0, received ? `${runtimeLauncher} --mode rpc` : concise(errors || `RPC exited with code ${String(code)}`)));
		child.stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
		const timeout = setTimeout(() => {
			child.kill("SIGTERM");
			finish(false, "RPC did not answer within 45 seconds");
		}, 45_000);
	});
}

function concise(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
