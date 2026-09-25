import { expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseModelAdmissionProvider } from "../src/model-admission.js";

it("checks current organization approval before each direct provider request", async () => {
	let approved = ["openai"];
	const rpc = vi.fn(async () => ({ data: approved, error: null }));
	const admission = new SupabaseModelAdmissionProvider({ rpc } as unknown as SupabaseClient);
	expect((await admission.check("project", "openai", "gpt-test", "off")).blocked).toBe(false);
	approved = [];
	expect((await admission.check("project", "openai", "gpt-test", "off")).blocked).toBe(true);
	expect((await admission.check("project", "anthropic", "claude-test", "off")).blocked).toBe(true);
	expect(rpc).toHaveBeenCalledWith("approved_provider_ids", { project_id_input: "project" });
});
