import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getInstallationPaths } from "./paths.js";

export async function appendDiagnosticLog(scope: string, message: string): Promise<string> {
	const logPath = path.join(getInstallationPaths().logs, `${scope}.log`);
	await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
	const safeMessage = message
		.replace(/(?:sk|key|token|secret|password)[-_][A-Za-z0-9._-]{8,}/gi, "[redacted]")
		.replace(/(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi, "$1=[redacted]");
	await appendFile(logPath, `[${new Date().toISOString()}] ${safeMessage}\n`, { mode: 0o600 });
	return logPath;
}
