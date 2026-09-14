export type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export class UnsupportedPlatformError extends Error {
	readonly code = "UNSUPPORTED_PLATFORM";

	constructor(readonly operatingSystem: string, readonly architecture: string) {
		super(`Pi Student does not support ${operatingSystem}/${architecture}. Supported systems are macOS and Linux on arm64 or x64.`);
		this.name = "UnsupportedPlatformError";
	}
}

export function normalizePlatform(operatingSystem: string = process.platform, architecture: string = process.arch): Platform {
	const os = operatingSystem.toLowerCase();
	const arch = architecture.toLowerCase();
	const normalizedOs = os === "darwin" || os === "macos" ? "darwin" : os === "linux" ? "linux" : undefined;
	const normalizedArch = arch === "arm64" || arch === "aarch64"
		? "arm64"
		: arch === "x64" || arch === "x86_64" || arch === "amd64"
			? "x64"
			: undefined;
	if (!normalizedOs || !normalizedArch) throw new UnsupportedPlatformError(operatingSystem, architecture);
	return `${normalizedOs}-${normalizedArch}` as Platform;
}

export function qemuSystemExecutable(platform: Platform): string {
	return platform.endsWith("-arm64") ? "qemu-system-aarch64" : "qemu-system-x86_64";
}

export function gondolinImageArchitecture(platform: Platform): "aarch64" | "x86_64" {
	return platform.endsWith("-arm64") ? "aarch64" : "x86_64";
}
