import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Platform } from "./platform.js";
import type { SandboxBackend } from "./runtime.js";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";

export interface RuntimeMetadata {
	backend: SandboxBackend;
	platform: Platform;
	verified: boolean;
	verifiedAt: string;
	executablePath: string;
	imageSelector: string;
}

export async function readRuntimeMetadata(filePath = getInstallationPaths().runtimeMetadata): Promise<RuntimeMetadata | undefined> {
	try {
		const value = JSON.parse(await readFile(filePath, "utf8")) as Partial<RuntimeMetadata>;
		if ((value.backend !== "krun" && value.backend !== "qemu") || typeof value.platform !== "string" || value.verified !== true || typeof value.executablePath !== "string") return undefined;
		return value as RuntimeMetadata;
	} catch {
		return undefined;
	}
}

export async function writeRuntimeMetadata(metadata: RuntimeMetadata, filePath = getInstallationPaths().runtimeMetadata): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, filePath);
}
