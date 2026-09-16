import { prepareSandboxImage, runSandboxHealthCheck } from "./health-check.js";

try {
	process.stdout.write("Preparing secure coding environment...\n");
	await prepareSandboxImage();
	const result = await runSandboxHealthCheck();
	process.stdout.write(`Sandbox smoke test passed (${result.runtime.backend}).\n`);
	for (const failure of result.fallbackFailures) process.stdout.write(`Fallback: ${failure}\n`);
} catch (error) {
	process.stderr.write(`Sandbox smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
