export interface SandboxConfig {
	mode: "host" | "gondolin";
	internetAllowed?: boolean;
	/** Fully resolved by the control plane; never a host path or install command. */
	profile?: SandboxProfile;
}

export interface ManagedDataset {
	id: string;
	organizationId: string;
	name: string;
	version: string;
	sizeBytes: number;
	/** Immutable object-store reference, not a filesystem path or URL. */
	artifactId: string;
	sha256: string;
	scope: ExtensionScope;
	classId?: string;
	projectId?: string;
	mountPath: string;
	access: "read-only" | "read-write";
}

export type ExtensionScope = "organization" | "class" | "project";
export type ExtensionCapability = "filesystem" | "network" | "shell" | "github" | "database" | "external_api" | "secrets";

export interface SandboxProfile {
	id: string;
	organizationId: string;
	name: string;
	version: number;
	runtime: "python" | "node" | "generic";
	runtimeVersion: string;
	/** Pinned package versions and integrity hashes only; no install scripts on the host. */
	packages: ReadonlyArray<{ name: string; version: string; integrity: string }>;
	imageDigest: string;
	buildStatus: "ready";
	datasets: readonly ManagedDataset[];
	network: { allowed: boolean; allowedHosts: readonly string[] };
	limits: { cpuMillis: number; memoryMiB: number; storageMiB: number; timeoutSeconds: number };
	metadata: Readonly<Record<string, string>>;
}

export interface SandboxProfileProvider {
	resolveSandbox(context: { projectId?: string; classId?: string; organizationId?: string }): Promise<SandboxConfig>;
}

export interface SandboxRuntimeDescriptor {
	provider: string;
	mode: SandboxConfig["mode"];
	workspacePath: string;
}
