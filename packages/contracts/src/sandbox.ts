export interface SandboxConfig {
	mode: "host" | "gondolin";
	internetAllowed?: boolean;
}

export interface SandboxRuntimeDescriptor {
	provider: string;
	mode: SandboxConfig["mode"];
	workspacePath: string;
}
