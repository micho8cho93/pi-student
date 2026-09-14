import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getInstallationPaths } from "../install/paths.js";

export interface SupabaseConfig { url: string; publishableKey: string }

export function readSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig | undefined {
	const url = env.PI_STUDENT_SUPABASE_URL?.trim();
	const publishableKey = (env.PI_STUDENT_SUPABASE_PUBLISHABLE_KEY ?? env.PI_STUDENT_SUPABASE_ANON_KEY)?.trim();
	if (!url && !publishableKey) {
		try {
			const saved = JSON.parse(readFileSync(path.join(getInstallationPaths(env).config, "classroom.json"), "utf8")) as SupabaseConfig;
			if (!saved.url || !saved.publishableKey) throw new Error("Saved classroom configuration is incomplete.");
			return readSupabaseConfig({ ...env, PI_STUDENT_SUPABASE_URL: saved.url, PI_STUDENT_SUPABASE_PUBLISHABLE_KEY: saved.publishableKey });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	if (!url || !publishableKey) throw new Error("Set both PI_STUDENT_SUPABASE_URL and PI_STUDENT_SUPABASE_PUBLISHABLE_KEY.");
	if (!/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(url)) {
		throw new Error("PI_STUDENT_SUPABASE_URL must use HTTPS (HTTP is allowed only for localhost development).");
	}
	return { url: url.replace(/\/$/, ""), publishableKey };
}

/** Store only the public connection settings so classes also work outside the repository. */
export function saveSupabaseConfig(config: SupabaseConfig): void {
 const directory = getInstallationPaths().config;
 mkdirSync(directory, { recursive: true, mode: 0o700 });
 writeFileSync(path.join(directory, "classroom.json"), JSON.stringify(config) + "\n", { mode: 0o600 });
}
