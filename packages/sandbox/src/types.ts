import path from "node:path";
import type { SandboxConfig } from "@pi-student/contracts";

export const SANDBOX_WORKSPACE = "/workspace";

export type SandboxMode = "host" | "gondolin";

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeout?: number;
	onData?: (data: Buffer) => void;
}

export interface ExecResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface SandboxFileStat {
	isDirectory(): boolean;
}

export interface SandboxRuntime {
	readonly mode?: SandboxMode;
	/** Providers must reject profiles they cannot faithfully enforce. */
	configure?(configuration: SandboxConfig): Promise<void>;
	setInternetAllowed?(allowed: boolean): void;
	start(projectPath: string): Promise<void>;
	stop(): Promise<void>;
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	readFile(path: string): Promise<string>;
	readBytes?(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string): Promise<void>;
	mkdir?(path: string): Promise<void>;
	fileExists(path: string): Promise<boolean>;
	listFiles(path?: string): Promise<string[]>;
	listDirectory?(path: string): Promise<string[]>;
	getWorkspacePath(): string;
	isRunning(): boolean;
	/** Optional because alternate backends may expose only listFiles/fileExists. */
	stat?(path: string): Promise<SandboxFileStat>;
}

export class SandboxRuntimeError extends Error {
	readonly code: string = "SANDBOX_RUNTIME_ERROR";

	constructor(message: string, readonly runtime: SandboxMode, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "SandboxRuntimeError";
	}
}

export class SandboxExecutionError extends SandboxRuntimeError {
	readonly code = "SANDBOX_EXEC_FAILED";

	constructor(
		message: string,
		readonly command: string,
		readonly cwd: string,
		runtime: SandboxMode,
		readonly exitCode?: number | null,
		options?: { cause?: unknown },
	) {
		super(message, runtime, options);
		this.name = "SandboxExecutionError";
	}
}

export function resolveSandboxPath(candidate = "."): string {
	const normalized = candidate.trim();
	if (!normalized) return SANDBOX_WORKSPACE;
	return path.posix.normalize(path.posix.isAbsolute(normalized)
		? normalized
		: path.posix.join(SANDBOX_WORKSPACE, normalized));
}

export function isSandboxPath(candidate: string): boolean {
	const resolved = resolveSandboxPath(candidate);
	return resolved === SANDBOX_WORKSPACE || resolved.startsWith(`${SANDBOX_WORKSPACE}/`);
}

export function assertSandboxPath(candidate: string): string {
	const resolved = resolveSandboxPath(candidate);
	if (!isSandboxPath(resolved)) {
		throw new Error(`Path is outside the sandbox workspace: ${candidate}`);
	}
	return resolved;
}
