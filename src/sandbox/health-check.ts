import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureGuestAssets, hasGuestAssets } from "@earendil-works/gondolin";
import { GondolinRuntime } from "./gondolin-runtime.js";
import { normalizePlatform } from "./platform.js";
import { writeRuntimeMetadata } from "./runtime-metadata.js";
import type { ResolvedSandboxRuntime } from "./runtime.js";

export const DEFAULT_IMAGE_SELECTOR = "alpine-base:latest";
export const SMOKE_TEST_MARKER = "pi-student-sandbox-ok";

export interface SandboxHealthResult {
	runtime: ResolvedSandboxRuntime;
	imageAvailable: boolean;
	bootSuccessful: boolean;
	fallbackFailures: readonly string[];
}

export async function prepareSandboxImage(): Promise<void> {
	await ensureGuestAssets();
}

export function isSandboxImageAvailable(): boolean {
	return hasGuestAssets();
}

export async function runSandboxHealthCheck(options: { persistMetadata?: boolean; runtime?: GondolinRuntime } = {}): Promise<SandboxHealthResult> {
	const project = await mkdtemp(path.join(os.tmpdir(), "pi-student-health-"));
	const runtime = options.runtime ?? new GondolinRuntime();
	try {
		await access(project);
		await runtime.start(project);
		const result = await runtime.exec(`/bin/echo ${SMOKE_TEST_MARKER}`, { timeout: 30 });
		if (result.exitCode !== 0 || result.stdout.trim() !== SMOKE_TEST_MARKER) {
			throw new Error(`Secure coding environment returned an unexpected smoke-test result (exit ${String(result.exitCode)}).`);
		}
		const selected = runtime.getSelectedRuntime();
		if (!selected) throw new Error("Secure coding runtime selection was not recorded.");
		if (options.persistMetadata !== false) {
			await writeRuntimeMetadata({
				backend: selected.backend,
				platform: normalizePlatform(),
				verified: true,
				verifiedAt: new Date().toISOString(),
				executablePath: selected.executablePath,
				imageSelector: process.env.GONDOLIN_DEFAULT_IMAGE?.trim() || DEFAULT_IMAGE_SELECTOR,
			});
		}
		return { runtime: selected, imageAvailable: true, bootSuccessful: true, fallbackFailures: runtime.getBackendFailures() };
	} finally {
		await runtime.stop().catch(() => undefined);
		await rm(project, { recursive: true, force: true });
	}
}
