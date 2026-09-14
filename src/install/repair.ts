import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { getInstallationPaths } from "./paths.js";
import { installLauncher } from "./launcher.js";
import { appendDiagnosticLog } from "./logging.js";
import { prepareSandboxImage, runSandboxHealthCheck } from "../sandbox/health-check.js";
import { writePaseoConfig } from "../integrations/paseo/config.js";

export async function runRepair(options: { verbose?: boolean } = {}): Promise<boolean> {
	const paths = getInstallationPaths();
	try {
		for (const directory of [paths.root, paths.bin, paths.runtime, paths.images, paths.cache, paths.logs, paths.config]) {
			await mkdir(directory, { recursive: true, mode: 0o700 });
		}
		process.stdout.write("Repairing Pi Student...\n\n");
		await installLauncher(paths);
		process.stdout.write("✓ Command installed\n");
		let paseoInstalled = true;
		try {
			await access(paths.paseoExecutable, constants.X_OK);
		} catch {
			paseoInstalled = false;
		}
		if (paseoInstalled) {
			await writePaseoConfig(paths);
			process.stdout.write("✓ Paseo GUI configured\n");
		} else if (options.verbose) {
			process.stdout.write("  GUI not installed (terminal-only installation)\n");
		}
		process.stdout.write("Preparing secure coding environment...\n");
		await prepareSandboxImage();
		process.stdout.write("✓ Secure coding environment prepared\n");
		const result = await runSandboxHealthCheck();
		process.stdout.write("✓ Sandbox verified\n");
		if (options.verbose) {
			process.stdout.write(`  Backend: ${result.runtime.backend}\n  Runtime: ${result.runtime.executablePath}\n`);
			if (result.fallbackFailures.length) process.stdout.write(`  Fallback: ${result.fallbackFailures.join(" ")}\n`);
		}
		process.stdout.write("\nPi Student is ready.\n");
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const logPath = await appendDiagnosticLog("repair", message).catch(() => paths.logs);
		process.stderr.write(`\nPi Student repair could not complete.\n\n${options.verbose ? `${message}\n\n` : ""}Run the installation command again to repair application or native runtime files.\n\nDiagnostic log:\n  ${logPath}\n`);
		return false;
	}
}
