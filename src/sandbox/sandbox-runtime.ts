export type { ExecOptions, ExecResult, SandboxFileStat, SandboxMode, SandboxRuntime } from "./types.js";
export {
	SANDBOX_WORKSPACE,
	SandboxExecutionError,
	SandboxRuntimeError,
	assertSandboxPath,
	isSandboxPath,
	resolveSandboxPath,
} from "./types.js";

import type { SandboxRuntime } from "./types.js";

/**
 * Small factory seam for future Docker, OpenShell, or remote implementations.
 * Callers should receive a SandboxRuntime, never a backend-specific object.
 */
export type SandboxRuntimeFactory = (projectPath: string) => SandboxRuntime;
