import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSupabaseConfig } from "@pi-student/supabase-adapter/config";

describe("Supabase adapter configuration", () => {
	it("loads saved configuration and validates transport", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-class-config-"));
		try {
			await mkdir(path.join(root, "config"));
			await writeFile(path.join(root, "config/classroom.json"), JSON.stringify({ url: "https://school.supabase.co", publishableKey: "public" }));
			expect(readSupabaseConfig({ PI_STUDENT_HOME: root })).toEqual({ url: "https://school.supabase.co", publishableKey: "public" });
			expect(() => readSupabaseConfig({ PI_STUDENT_SUPABASE_URL: "http://example.test", PI_STUDENT_SUPABASE_PUBLISHABLE_KEY: "test" })).toThrow(/HTTPS/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
