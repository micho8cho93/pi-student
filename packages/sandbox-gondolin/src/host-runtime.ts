import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	SandboxExecutionError,
	SandboxRuntimeError,
	SANDBOX_WORKSPACE,
	type ExecOptions,
	type ExecResult,
	type SandboxFileStat,
	type SandboxRuntime,
} from "@pi-student/sandbox/types";
import type { SandboxProviderCapabilities } from "@pi-student/contracts";

/** Development/test backend. Unsafe for student use: processes run on the host. */
export class HostRuntime implements SandboxRuntime {
	readonly mode = "host" as const;
	getCapabilities(): SandboxProviderCapabilities {
		return { provider: "host-development", mode: "host", capabilities: ["workspace"] };
	}
	private projectPath?: string;
	private running = false;

	async start(projectPath: string): Promise<void> {
		const resolved = path.resolve(projectPath);
		const info = await stat(resolved).catch(() => undefined);
		if (!info?.isDirectory()) throw new SandboxRuntimeError(`Project directory does not exist: ${resolved}`, "host");
		this.projectPath = resolved;
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.projectPath = undefined;
	}

	isRunning(): boolean {
		return this.running;
	}

	getWorkspacePath(): string {
		return SANDBOX_WORKSPACE;
	}

	async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const projectPath = this.requireProject();
		const cwd = this.toHostPath(options.cwd ?? SANDBOX_WORKSPACE);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		if (options.signal?.aborted) throw new SandboxExecutionError("Execution aborted", command, cwd, "host");

		return await new Promise<ExecResult>((resolve, reject) => {
			const child = spawn("/bin/sh", ["-lc", command], {
				cwd,
				env: { ...process.env, ...filterEnv(options.env) },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let settled = false;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				callback();
			};
			const abort = () => child.kill("SIGTERM");
			const timer = options.timeout && options.timeout > 0 ? setTimeout(() => child.kill("SIGTERM"), options.timeout * 1000) : undefined;
			child.stdout.on("data", (data: Buffer) => {
				stdout.push(data);
				options.onData?.(data);
			});
			child.stderr.on("data", (data: Buffer) => {
				stderr.push(data);
				options.onData?.(data);
			});
			child.once("error", (error) => finish(() => reject(new SandboxExecutionError(error.message, command, cwd, "host", undefined, { cause: error }))));
			child.once("close", (exitCode) => finish(() => resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") })));
			options.signal?.addEventListener("abort", abort, { once: true });
			const cleanup = () => {
				if (timer) clearTimeout(timer);
				options.signal?.removeEventListener("abort", abort);
			};
			child.once("close", cleanup);
		});
	}

	async readBytes(filePath: string): Promise<Uint8Array> {
		return readFile(this.toHostPath(filePath));
	}

	async readFile(filePath: string): Promise<string> {
		return readFile(this.toHostPath(filePath), "utf8");
	}

	async writeFile(filePath: string, content: string): Promise<void> {
		const target = this.toHostPath(filePath);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content, "utf8");
	}

	async mkdir(directory: string): Promise<void> {
		await mkdir(this.toHostPath(directory), { recursive: true });
	}

	async fileExists(filePath: string): Promise<boolean> {
		try {
			await access(this.toHostPath(filePath), constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	async stat(filePath: string): Promise<SandboxFileStat> {
		return stat(this.toHostPath(filePath));
	}

	async listFiles(filePath = SANDBOX_WORKSPACE): Promise<string[]> {
		const guestRoot = this.resolveGuestPath(filePath);
		const hostRoot = this.toHostPath(guestRoot);
		const rootStat = await stat(hostRoot);
		if (!rootStat.isDirectory()) return [guestRoot];
		const results: string[] = [];
		const visit = async (directory: string, guestDirectory: string): Promise<void> => {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				const guestPath = path.posix.join(guestDirectory, entry.name);
				const hostPath = path.join(directory, entry.name);
				if (entry.isDirectory()) await visit(hostPath, guestPath);
				else results.push(guestPath);
			}
		};
		await visit(hostRoot, guestRoot);
		return results;
	}

	async listDirectory(filePath: string): Promise<string[]> {
		return readdir(this.toHostPath(filePath));
	}

	private requireProject(): string {
		if (!this.running || !this.projectPath) throw new SandboxRuntimeError("Host runtime is not running", "host");
		return this.projectPath;
	}

	private resolveGuestPath(candidate: string): string {
		const trimmed = candidate.trim();
		if (!trimmed) return SANDBOX_WORKSPACE;
		if (path.isAbsolute(trimmed) && !trimmed.startsWith(`${SANDBOX_WORKSPACE}/`) && trimmed !== SANDBOX_WORKSPACE) {
			throw new SandboxRuntimeError(`Host runtime refuses paths outside ${SANDBOX_WORKSPACE}: ${candidate}`, "host");
		}
		const guestPath = path.posix.normalize(trimmed.startsWith("/") ? trimmed : path.posix.join(SANDBOX_WORKSPACE, trimmed));
		if (guestPath !== SANDBOX_WORKSPACE && !guestPath.startsWith(`${SANDBOX_WORKSPACE}/`)) {
			throw new SandboxRuntimeError(`Path escapes ${SANDBOX_WORKSPACE}: ${candidate}`, "host");
		}
		return guestPath;
	}

	private toHostPath(candidate: string): string {
		const projectPath = this.requireProject();
		const guestPath = this.resolveGuestPath(candidate);
		return path.join(projectPath, path.posix.relative(SANDBOX_WORKSPACE, guestPath));
	}
}

function filterEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
