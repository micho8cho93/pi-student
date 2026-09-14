import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePlatform, qemuSystemExecutable, type Platform } from "./platform.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export type SandboxBackend = "krun" | "qemu";

export interface ResolvedSandboxRuntime {
	backend: SandboxBackend;
	executablePath: string;
	qemuImgPath?: string;
	platform: Platform;
	status: "ready";
}

export interface RuntimeResolutionOptions {
	platform?: Platform;
	env?: NodeJS.ProcessEnv;
	excludeBackends?: ReadonlySet<SandboxBackend>;
	findExecutable?: (name: string, env?: NodeJS.ProcessEnv) => Promise<string | undefined>;
	probeExecutable?: (executablePath: string) => Promise<boolean>;
	resolveKrunRunner?: (platform: Platform, env?: NodeJS.ProcessEnv) => Promise<string | undefined>;
}

export class SandboxRuntimeUnavailableError extends Error {
	readonly code = "SANDBOX_RUNTIME_UNAVAILABLE";

	constructor(readonly platform: Platform, readonly details: string[]) {
		super(`Pi Student could not find a usable secure coding runtime for ${platform}. ${details.join(" ")}`);
		this.name = "SandboxRuntimeUnavailableError";
	}
}

export const KRUN_PLATFORMS = new Set<Platform>(["darwin-arm64", "linux-x64"]);

export async function resolveSandboxRuntime(options: RuntimeResolutionOptions = {}): Promise<ResolvedSandboxRuntime> {
	const platform = options.platform ?? normalizePlatform();
	const env = options.env ?? process.env;
	const excluded = options.excludeBackends ?? new Set<SandboxBackend>();
	const find = options.findExecutable ?? findExecutable;
	const probe = options.probeExecutable ?? probeExecutable;
	const resolveKrun = options.resolveKrunRunner ?? resolvePackagedKrunRunner;
	const details: string[] = [];

	if (!excluded.has("krun") && KRUN_PLATFORMS.has(platform)) {
		const krunRunner = await resolveKrun(platform, env);
		if (krunRunner && await probe(krunRunner)) {
			return { backend: "krun", executablePath: krunRunner, platform, status: "ready" };
		}
		details.push("The packaged krun runtime is missing or could not start.");
	}

	if (!excluded.has("qemu")) {
		const qemuName = qemuSystemExecutable(platform);
		const [qemuPath, qemuImgPath] = await Promise.all([find(qemuName, env), find("qemu-img", env)]);
		if (qemuPath && qemuImgPath && await probe(qemuPath) && await probe(qemuImgPath)) {
			return { backend: "qemu", executablePath: qemuPath, qemuImgPath, platform, status: "ready" };
		}
		if (!qemuPath) details.push(`${qemuName} was not found.`);
		if (!qemuImgPath) details.push("qemu-img was not found.");
	}

	throw new SandboxRuntimeUnavailableError(platform, details);
}

export async function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	if (path.isAbsolute(name) || name.includes(path.sep)) return await isExecutable(name) ? path.resolve(name) : undefined;
	for (const directory of (env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, name);
		if (await isExecutable(candidate)) return candidate;
	}
	return undefined;
}

async function isExecutable(candidate: string): Promise<boolean> {
	try {
		await access(candidate, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export async function probeExecutable(executablePath: string): Promise<boolean> {
	try {
		await execFileAsync(executablePath, ["--version"], { timeout: 5_000, windowsHide: true });
		return true;
	} catch {
		return false;
	}
}

export async function resolvePackagedKrunRunner(platform: Platform, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const explicit = env.PI_STUDENT_KRUN_RUNNER?.trim() || env.GONDOLIN_KRUN_RUNNER?.trim();
	if (explicit) return findExecutable(explicit, env);
	if (!KRUN_PLATFORMS.has(platform)) return undefined;
	const packageName = `@earendil-works/gondolin-krun-runner-${platform}`;
	try {
		const packageJsonPath = require.resolve(`${packageName}/package.json`);
		return findExecutable(path.join(path.dirname(packageJsonPath), "bin", "gondolin-krun-runner"), env);
	} catch {
		return undefined;
	}
}
