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

it("keeps tutoring admitted when only the agent lane of an institution budget is closed", async () => {
	const rpc = vi.fn(async (name: string) => ({ error: null, data: name === "approved_model_profiles"
		? [{ id: "profile", provider: "openai", provider_model: "gpt-test", allowed_thinking_levels: ["off"] }]
		: { warning: true, blocked: false, agentBlocked: true } }));
	const auth = { getSession: async () => ({ data: { session: { access_token: "jwt" } }, error: null }) };
	const admission = new SupabaseModelAdmissionProvider({ rpc, auth } as unknown as SupabaseClient);
	expect(await admission.check("project", "institution", "profile", "off", undefined, "agent")).toMatchObject({ blocked: true, action: "assistance_only" });
	expect(await admission.check("project", "institution", "profile", "off", undefined, "tutoring")).toMatchObject({ blocked: false, agentBlocked: true });
	expect(await admission.check("project", "institution", "profile", "off", undefined, "autocomplete")).toMatchObject({ blocked: false });
});

it("treats a server without the reserve as closing every lane", async () => {
	const rpc = vi.fn(async (name: string) => ({ error: null, data: name === "approved_model_profiles"
		? [{ id: "profile", provider: "openai", provider_model: "gpt-test", allowed_thinking_levels: ["off"] }]
		: { warning: true, blocked: true, action: "block_ai" } }));
	const auth = { getSession: async () => ({ data: { session: { access_token: "jwt" } }, error: null }) };
	const admission = new SupabaseModelAdmissionProvider({ rpc, auth } as unknown as SupabaseClient);
	expect(await admission.check("project", "institution", "profile", "off", undefined, "tutoring")).toMatchObject({ blocked: true, agentBlocked: true, action: "block_ai" });
});
