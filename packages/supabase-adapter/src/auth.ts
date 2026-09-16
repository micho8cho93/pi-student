import { createClient, type SupabaseClient, type SupportedStorage } from "@supabase/supabase-js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";
import type { SupabaseConfig } from "./config.js";

class SecureFileAuthStorage implements SupportedStorage {
	constructor(private readonly filePath = path.join(getInstallationPaths().config, "supabase-auth.json")) {}
	async getItem(key: string): Promise<string | null> { return (await this.read())[key] ?? null; }
	async setItem(key: string, value: string): Promise<void> { const values = await this.read(); values[key] = value; await this.write(values); }
	async removeItem(key: string): Promise<void> { const values = await this.read(); delete values[key]; await this.write(values); }
	private async read(): Promise<Record<string, string>> {
		try { return JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, string>; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
	}
	private async write(values: Record<string, string>): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(values)}\n`, { mode: 0o600 });
		await rename(temporary, this.filePath);
	}
}

export function createPiSupabaseClient(config: SupabaseConfig): SupabaseClient {
	return createClient(config.url, config.publishableKey, { auth: { flowType: "pkce", persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage: new SecureFileAuthStorage() } });
}
