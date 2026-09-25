import type { SandboxProvider } from "@pi-student/sandbox/sandbox-manager";
import type { SandboxMode, SandboxRuntime } from "@pi-student/sandbox/types";
import type { SandboxProviderCapabilities } from "@pi-student/contracts";
import { GondolinRuntime } from "./gondolin-runtime.js";
import { HostRuntime } from "./host-runtime.js";

/** Default local provider. Host mode remains an explicit unsafe developer escape hatch. */
export class GondolinSandboxProvider implements SandboxProvider {
	capabilities(mode: SandboxMode): SandboxProviderCapabilities {
		return mode === "host"
			? { provider: "host-development", mode, capabilities: ["workspace"] }
			: { provider: "gondolin", mode, capabilities: ["workspace", "internet-policy", "blocked-hosts"] };
	}

	create(mode: SandboxMode): SandboxRuntime {
		return mode === "host" ? new HostRuntime() : new GondolinRuntime();
	}
}

export function createSandboxRuntime(mode: SandboxMode): SandboxRuntime {
	return new GondolinSandboxProvider().create(mode);
}
