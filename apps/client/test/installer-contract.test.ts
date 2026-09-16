import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";
import { installLauncher } from "../src/install/launcher.js";

describe("curl installer contract", () => {
	it("is strict, checksum-verifying, idempotent, and performs a real repair check", async () => {
		const script = await readFile(new URL("../../../install.sh", import.meta.url), "utf8");
		expect(script).toContain("set -eu");
		expect(script).toContain("--proto '=https'");
		expect(script).toContain("verify_checksum");
		expect(script).toContain("grep -Fqx");
		expect(script).toContain("apps/client/dist/cli.js\" repair");
		expect(script).toContain("restore_previous");
		expect(script).toContain("command -v qemu-img");
		expect(script).toContain("command -v \"$QEMU_SYSTEM\"");
		expect(script).toContain("@getpaseo/cli@$PASEO_VERSION");
		expect(script).toContain("--terminal-only");
		expect(script).toContain("install_paseo");
	});

	it("installs the same launchers idempotently", async () => {
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
			expect(runtime).toContain('\"${APP}\" runtime');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
