import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installLauncher } from "../install/launcher.js";
import { getInstallationPaths } from "../install/paths.js";
import { GondolinRuntime } from "../sandbox/gondolin-runtime.js";
import { normalizePlatform, UnsupportedPlatformError } from "../sandbox/platform.js";
import { readRuntimeMetadata, writeRuntimeMetadata } from "../sandbox/runtime-metadata.js";
import { resolveSandboxRuntime, SandboxRuntimeUnavailableError } from "../sandbox/runtime.js";

describe("platform normalization", () => {
	it.each([
		["darwin", "arm64", "darwin-arm64"],
		["macos", "x86_64", "darwin-x64"],
		["linux", "amd64", "linux-x64"],
		["linux", "aarch64", "linux-arm64"],
	] as const)("normalizes %s/%s", (platform, arch, expected) => {
		expect(normalizePlatform(platform, arch)).toBe(expected);
	});

	it("rejects unsupported systems with a concise error", () => {
		expect(() => normalizePlatform("win32", "x64")).toThrow(UnsupportedPlatformError);
	});
});

describe("sandbox backend selection", () => {
	const workingProbe = async () => true;

	it("prefers a packaged krun runner", async () => {
		const result = await resolveSandboxRuntime({
			platform: "darwin-arm64",
			resolveKrunRunner: async () => "/runtime/krun",
			probeExecutable: workingProbe,
			findExecutable: async () => "/runtime/qemu",
		});
		expect(result).toMatchObject({ backend: "krun", executablePath: "/runtime/krun", status: "ready" });
	});

	it("falls back to QEMU only when both required executables work", async () => {
		const result = await resolveSandboxRuntime({
			platform: "linux-x64",
			resolveKrunRunner: async () => "/broken/krun",
			probeExecutable: async (value) => value !== "/broken/krun",
			findExecutable: async (name) => `/usr/bin/${name}`,
		});
		expect(result.backend).toBe("qemu");
		expect(result.qemuImgPath).toBe("/usr/bin/qemu-img");
	});

	it("rejects QEMU when qemu-img is missing", async () => {
		await expect(resolveSandboxRuntime({
			platform: "linux-arm64",
			findExecutable: async (name) => name === "qemu-img" ? undefined : `/usr/bin/${name}`,
			probeExecutable: workingProbe,
		})).rejects.toMatchObject({ details: expect.arrayContaining(["qemu-img was not found."]) });
	});

	it("fails closed when no sandbox backend exists", async () => {
		const runtime = new GondolinRuntime({
			platform: "linux-arm64",
			findExecutable: async () => undefined,
			probeExecutable: async () => false,
		});
		await expect(runtime.start(process.cwd())).rejects.toThrow(/secure coding environment/i);
		expect(runtime.isRunning()).toBe(false);
	});

	it("returns a typed error when no runtime exists", async () => {
		await expect(resolveSandboxRuntime({
			platform: "darwin-x64",
			findExecutable: async () => undefined,
		})).rejects.toBeInstanceOf(SandboxRuntimeUnavailableError);
	});
});

describe("installation state", () => {
	it("round-trips verified runtime metadata", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pi-student-metadata-"));
		const metadataPath = path.join(directory, "runtime.json");
		try {
			await writeRuntimeMetadata({ backend: "krun", platform: "darwin-arm64", verified: true, verifiedAt: "2026-09-12T00:00:00.000Z", executablePath: "/runtime/krun", imageSelector: "alpine-base:latest" }, metadataPath);
			expect(await readRuntimeMetadata(metadataPath)).toMatchObject({ backend: "krun", verified: true });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("installs the same launcher idempotently", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-student-launcher-"));
		const paths = getInstallationPaths({ PI_STUDENT_HOME: root });
		try {
			await installLauncher(paths);
			const first = await readFile(paths.launcher, "utf8");
			const short = await readFile(paths.shortLauncher, "utf8");
			const runtime = await readFile(paths.runtimeLauncher, "utf8");
			expect(short).toBe(first);
			await installLauncher(paths);
			expect(await readFile(paths.launcher, "utf8")).toBe(first);
			expect(first).toContain("runtime/node/bin/node");
			expect(runtime).toContain('"${APP}" runtime');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
