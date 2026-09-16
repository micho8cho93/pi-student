import path from "node:path";
import os from "node:os";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { ensureGuestAssets, RealFSProvider, VM } from "@earendil-works/gondolin";
import {
	SandboxExecutionError,
	SandboxRuntimeError,
	SANDBOX_WORKSPACE,
	type ExecOptions,
	type ExecResult,
	type SandboxFileStat,
	type SandboxRuntime,
} from "@pi-student/sandbox/types";
import {
	resolveSandboxRuntime,
	SandboxRuntimeUnavailableError,
	type ResolvedSandboxRuntime,
	type RuntimeResolutionOptions,
} from "./runtime.js";

const GUEST_ENV: Record<string, string> = {
	HOME: "/root",
	LANG: "C.UTF-8",
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	TMPDIR: "/tmp",
};

/** Provider/runtime credentials are intentionally absent from this allowlist. */
export const SANDBOX_ENV_ALLOWLIST = new Set(["CI", "LANG", "LC_ALL", "NODE_ENV", "TERM", "TZ"]);

export class GondolinRuntime implements SandboxRuntime {
	private internetAllowed = true;
	setInternetAllowed(allowed: boolean): void { this.internetAllowed = allowed; }
	private vm?: VM;
	private projectPath?: string;
	private starting?: Promise<void>;
	private selectedRuntime?: ResolvedSandboxRuntime;
	private runtimeTempDirectory?: string;
	private backendFailures: string[] = [];

	constructor(private readonly resolutionOptions: RuntimeResolutionOptions = {}) {}

	async start(projectPath: string): Promise<void> {
		const resolved = path.resolve(projectPath);
		if (this.vm) {
			if (this.projectPath !== resolved) throw new SandboxRuntimeError("Gondolin runtime is already attached to another project", "gondolin");
			return;
		}
		if (this.starting) return this.starting;
		this.starting = this.startInternal(resolved).finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	private async startInternal(projectPath: string): Promise<void> {
		const resolved = path.resolve(projectPath);
		const excluded = new Set<"krun" | "qemu">();
		const failures: string[] = [];
		this.backendFailures = failures;
		while (excluded.size < 2) {
			let runtime: ResolvedSandboxRuntime;
			try {
				runtime = await resolveSandboxRuntime({ ...this.resolutionOptions, excludeBackends: excluded });
			} catch (error) {
				const detail = error instanceof SandboxRuntimeUnavailableError ? error.details.join(" ") : error instanceof Error ? error.message : String(error);
				throw new SandboxRuntimeError(
					`Could not start the secure coding environment. ${[...failures, detail].filter(Boolean).join(" ")}`,
					"gondolin",
					{ cause: error },
				);
			}

			let vm: VM | undefined;
			let runtimeTempDirectory: string | undefined;
			try {
				const assets = await ensureGuestAssets();
				let sandbox: NonNullable<Parameters<typeof VM.create>[0]>["sandbox"];
				if (runtime.backend === "krun") {
					// Gondolin's normal writable overlay shells out to qemu-img even for
					// krun. A reflink/copy gives krun its own writable raw disk without
					// turning QEMU into a hidden prerequisite.
					runtimeTempDirectory = await mkdtemp(path.join(os.tmpdir(), "pi-student-krun-"));
					const rootDiskPath = path.join(runtimeTempDirectory, "rootfs.ext4");
					await copyFile(assets.rootfsPath, rootDiskPath, fsConstants.COPYFILE_FICLONE);
					sandbox = {
						vmm: "krun",
						krunRunnerPath: runtime.executablePath,
						imagePath: assets,
						rootDiskPath,
						rootDiskFormat: "raw",
						rootDiskDeleteOnClose: true,
					};
				} else {
					sandbox = { vmm: "qemu", qemuPath: runtime.executablePath, imagePath: assets };
				}
				vm = await VM.create({
					httpHooks: { isRequestAllowed: () => this.internetAllowed },
					sessionLabel: `pi-student ${path.basename(resolved)}`,
					// RealFSProvider is the Gondolin VFS boundary: guest processes see only
					// /workspace, while the host project is never used as their cwd.
					vfs: { mounts: { [SANDBOX_WORKSPACE]: new RealFSProvider(resolved) } },
					env: GUEST_ENV,
					startTimeoutMs: 20_000,
					rootfs: { mode: "cow" },
					sandbox,
				});
				await vm.start();
				this.projectPath = resolved;
				this.selectedRuntime = runtime;
				this.runtimeTempDirectory = runtimeTempDirectory;
				this.vm = vm;
				return;
			} catch (error) {
				await vm?.close().catch(() => undefined);
				if (runtimeTempDirectory) await rm(runtimeTempDirectory, { recursive: true, force: true }).catch(() => undefined);
				excluded.add(runtime.backend);
				failures.push(`${runtime.backend} failed to initialize: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		throw new SandboxRuntimeError(`Could not start the secure coding environment. ${failures.join(" ")}`, "gondolin");
	}

	async stop(): Promise<void> {
		const starting = this.starting;
		if (starting) await starting.catch(() => undefined);
		const vm = this.vm;
		const runtimeTempDirectory = this.runtimeTempDirectory;
		this.vm = undefined;
		this.projectPath = undefined;
		this.selectedRuntime = undefined;
		this.runtimeTempDirectory = undefined;
		if (vm) await vm.close();
		if (runtimeTempDirectory) await rm(runtimeTempDirectory, { recursive: true, force: true });
	}

	isRunning(): boolean {
		return this.vm !== undefined;
	}

	getSelectedRuntime(): ResolvedSandboxRuntime | undefined {
		return this.selectedRuntime;
	}

	getBackendFailures(): readonly string[] {
		return this.backendFailures;
	}

	getWorkspacePath(): string {
		return SANDBOX_WORKSPACE;
	}

	async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const vm = this.requireVm();
		const cwd = resolveGuestPath(options.cwd ?? SANDBOX_WORKSPACE);
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		let timedOut = false;
		try {
			if (options.signal?.aborted) throw new Error("aborted");
			if (options.timeout && options.timeout > 0) timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, options.timeout * 1000);
			const process = vm.exec(["/bin/sh", "-lc", command], {
				cwd,
				env: buildSandboxEnv(options.env),
				signal: controller.signal,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			for await (const chunk of process.output()) {
				if (chunk.stream === "stdout") stdout.push(chunk.data);
				else stderr.push(chunk.data);
				options.onData?.(chunk.data);
			}
			const result = await process;
			return { exitCode: result.exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
		} catch (error) {
			const message = options.signal?.aborted ? "Execution aborted" : timedOut ? `Execution timed out after ${options.timeout} seconds` : error instanceof Error ? error.message : String(error);
			throw new SandboxExecutionError(message, command, cwd, "gondolin", undefined, { cause: error });
		} finally {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
	}

	async readBytes(filePath: string): Promise<Uint8Array> {
		return this.requireVm().fs.readFile(resolveGuestPath(filePath));
	}

	async readFile(filePath: string): Promise<string> {
		return this.requireVm().fs.readFile(resolveGuestPath(filePath), { encoding: "utf8" });
	}

	async writeFile(filePath: string, content: string): Promise<void> {
		await this.requireVm().fs.writeFile(resolveGuestPath(filePath), content, { encoding: "utf8" });
	}

	async mkdir(directory: string): Promise<void> {
		await this.requireVm().fs.mkdir(resolveGuestPath(directory), { recursive: true });
	}

	async fileExists(filePath: string): Promise<boolean> {
		try {
			await this.requireVm().fs.access(resolveGuestPath(filePath));
			return true;
		} catch {
			return false;
		}
	}

	async stat(filePath: string): Promise<SandboxFileStat> {
		return this.requireVm().fs.stat(resolveGuestPath(filePath));
	}

	async listFiles(filePath = SANDBOX_WORKSPACE): Promise<string[]> {
		const vm = this.requireVm();
		const root = resolveGuestPath(filePath);
		const rootStat = await vm.fs.stat(root);
		if (!rootStat.isDirectory()) return [root];
		const results: string[] = [];
		const visit = async (directory: string): Promise<void> => {
			for (const entry of await vm.fs.listDir(directory)) {
				if (entry === ".git" || entry === "node_modules") continue;
				const guestPath = path.posix.join(directory, entry);
				const entryStat = await vm.fs.stat(guestPath).catch(() => undefined);
				if (!entryStat) continue;
				if (entryStat.isDirectory()) await visit(guestPath);
				else results.push(guestPath);
			}
		};
		await visit(root);
		return results;
	}

	async listDirectory(filePath: string): Promise<string[]> {
		return this.requireVm().fs.listDir(resolveGuestPath(filePath));
	}

	private requireVm(): VM {
		if (!this.vm) throw new SandboxRuntimeError("Gondolin runtime is not running", "gondolin");
		return this.vm;
	}
}

function resolveGuestPath(candidate: string): string {
	const trimmed = candidate.trim();
	const resolved = path.posix.normalize(trimmed.startsWith("/") ? trimmed : path.posix.join(SANDBOX_WORKSPACE, trimmed || "."));
	if (resolved !== SANDBOX_WORKSPACE && !resolved.startsWith(`${SANDBOX_WORKSPACE}/`)) {
		throw new SandboxRuntimeError(`Path is outside ${SANDBOX_WORKSPACE}: ${candidate}`, "gondolin");
	}
	return resolved;
}

function buildSandboxEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
	const result = { ...GUEST_ENV };
	for (const [key, value] of Object.entries(env ?? {})) {
		if (SANDBOX_ENV_ALLOWLIST.has(key) && typeof value === "string") result[key] = value;
	}
	return result;
}
