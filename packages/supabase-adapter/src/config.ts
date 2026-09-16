import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";

export interface SupabaseConfig { url: string; publishableKey: string }

export function readSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | undefined {
	const url = env.PI_STUDENT_SUPABASE_URL?.trim();
	const publishableKey = env.PI_STUDENT_SUPABASE_PUBLISHABLE_KEY?.trim();
	if (url || publishableKey) return validateConfig({ url: url ?? "", publishableKey: publishableKey ?? "" });
	const filePath = path.join(getInstallationPaths(env).config, "classroom.json");
	try {
		const saved = JSON.parse(readFileSync(filePath, "utf8")) as Partial<SupabaseConfig>;
		return validateConfig({ url: saved.url ?? "", publishableKey: saved.publishableKey ?? "" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function saveSupabaseConfig(config: SupabaseConfig, env: NodeJS.ProcessEnv = process.env): void {
	const valid = validateConfig(config);
	const directory = getInstallationPaths(env).config;
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(directory, "classroom.json"), `${JSON.stringify(valid)}\n`, { mode: 0o600 });
}

function validateConfig(config: SupabaseConfig): SupabaseConfig {
	if (!config.url || !config.publishableKey) throw new Error("Classroom configuration is incomplete.");
	const url = new URL(config.url);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
		throw new Error("Classroom URL must use HTTPS, except for localhost development.");
	}
	return { url: url.toString().replace(/\/$/, ""), publishableKey: config.publishableKey };
}
