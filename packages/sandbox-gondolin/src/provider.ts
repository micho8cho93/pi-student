import type { SandboxProvider } from "@pi-student/sandbox/sandbox-manager";
import type { SandboxMode, SandboxRuntime } from "@pi-student/sandbox/types";
import { GondolinRuntime } from "./gondolin-runtime.js";
import { HostRuntime } from "./host-runtime.js";

/** Default local provider. Host mode remains an explicit unsafe developer escape hatch. */
export class GondolinSandboxProvider implements SandboxProvider {
	create(mode: SandboxMode): SandboxRuntime {
		return mode === "host" ? new HostRuntime() : new GondolinRuntime();
	}
}

export function createSandboxRuntime(mode: SandboxMode): SandboxRuntime {
	return new GondolinSandboxProvider().create(mode);
}
