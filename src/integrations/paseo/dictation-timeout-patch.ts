import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UPSTREAM_FINAL_TIMEOUT = "const DEFAULT_DICTATION_FINAL_TIMEOUT_MS = 10000;";
const PI_STUDENT_FINAL_TIMEOUT = "const DEFAULT_DICTATION_FINAL_TIMEOUT_MS = 120000; // pi-student: allow slow on-device final transcription";

/**
 * Voz can take longer than Paseo's ten-second base deadline to process a saved
 * recording, especially on the first run while the model is warming up. Keep
 * the stream alive long enough for that final result instead of reporting a
 * failure and discarding it.
 */
export async function patchPaseoDictationTimeout(paseoExecutable: string): Promise<boolean> {
	const managerPath = path.resolve(
		path.dirname(paseoExecutable),
		"..",
		"..",
		"node_modules",
		"@getpaseo",
		"server",
		"dist",
		"server",
		"server",
		"dictation",
		"dictation-stream-manager.js",
	);
	try {
		await access(managerPath);
	} catch {
		return false;
	}

	const original = await readFile(managerPath, "utf8");
	if (original.includes(PI_STUDENT_FINAL_TIMEOUT)) return false;
	if (!original.includes(UPSTREAM_FINAL_TIMEOUT)) return false;
	await writeFile(managerPath, original.replace(UPSTREAM_FINAL_TIMEOUT, PI_STUDENT_FINAL_TIMEOUT));
	return true;
}
