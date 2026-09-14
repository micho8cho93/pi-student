import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("curl installer contract", () => {
	it("is strict, checksum-verifying, idempotent, and performs a real repair check", async () => {
		const script = await readFile(path.resolve("install.sh"), "utf8");
		expect(script).toContain("set -eu");
		expect(script).toContain("--proto '=https'");
		expect(script).toContain("verify_checksum");
		expect(script).toContain("grep -Fqx");
		expect(script).toContain("dist/cli.js\" repair");
		expect(script).toContain("restore_previous");
		expect(script).toContain("command -v qemu-img");
		expect(script).toContain("command -v \"$QEMU_SYSTEM\"");
		expect(script).toContain("@getpaseo/cli@$PASEO_VERSION");
		expect(script).toContain("--terminal-only");
		expect(script).toContain("install_paseo");
	});
});
