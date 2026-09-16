import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";

export type DictationProviderPreference = "voz" | "openai" | "groq" | "local" | "command";

export interface DictationPreferences {
	provider?: DictationProviderPreference;
	command?: string;
	language?: string;
	model?: string;
}

export function getDictationConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getInstallationPaths(env).config, "dictation.json");
}

export async function readDictationPreferences(
	env: NodeJS.ProcessEnv = process.env,
	filePath = getDictationConfigPath(env),
): Promise<DictationPreferences> {
	try {
		const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const value = parsed as Record<string, unknown>;
		const provider = value.provider === "voz" || value.provider === "openai" || value.provider === "groq" || value.provider === "local" || value.provider === "command"
			? value.provider
			: undefined;
		return {
			provider,
			command: typeof value.command === "string" && value.command.trim() ? value.command.trim() : undefined,
			language: typeof value.language === "string" && value.language.trim() ? value.language.trim() : undefined,
			model: typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined,
		};
	} catch (error) {
		if (isNodeError(error, "ENOENT") || error instanceof SyntaxError) return {};
		throw error;
	}
}

export async function saveDictationPreferences(
	preferences: DictationPreferences,
	env: NodeJS.ProcessEnv = process.env,
	filePath = getDictationConfigPath(env),
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
	const temporaryPath = `${filePath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await chmod(temporaryPath, 0o600);
	await rename(temporaryPath, filePath);
	await chmod(filePath, 0o600);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
