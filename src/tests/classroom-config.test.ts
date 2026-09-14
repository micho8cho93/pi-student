import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSupabaseConfig } from "../teacher/config.js";

describe("saved classroom connection", () => {
	it("loads from the installation directory without a workspace env file", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-class-config-"));
		try {
			await mkdir(path.join(root, "config"));
			await writeFile(path.join(root, "config/classroom.json"), JSON.stringify({ url: "https://school.supabase.co", publishableKey: "public" }));
			expect(readSupabaseConfig({ PI_STUDENT_HOME: root })).toEqual({ url: "https://school.supabase.co", publishableKey: "public" });
			expect(readSupabaseConfig({ PI_STUDENT_HOME: root, PI_STUDENT_SUPABASE_URL: "https://override.supabase.co", PI_STUDENT_SUPABASE_PUBLISHABLE_KEY: "override" })?.url).toBe("https://override.supabase.co");
			await writeFile(path.join(root, "config/classroom.json"), "{}");
			expect(() => readSupabaseConfig({ PI_STUDENT_HOME: root })).toThrow("incomplete");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
