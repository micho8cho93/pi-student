import type { ModelAdmissionProvider, ThinkingLevel } from "@pi-student/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export class SupabaseModelAdmissionProvider implements ModelAdmissionProvider {
	constructor(private readonly client: SupabaseClient, private readonly refreshGatewayToken?: (token: string, sessionId?: string, thinkingLevel?: ThinkingLevel) => void) {}
	async check(projectId: string, provider: string, modelId: string, thinkingLevel: ThinkingLevel, sessionId?: string) {
		if (provider !== "institution") return { warning: false, blocked: true, action: "block_model" as const };
		const profiles = await this.client.rpc("approved_model_profiles", { project_id_input: projectId });
		if (profiles.error) throw profiles.error;
		const profile = (profiles.data as Array<{ id: string; provider: string; provider_model: string; allowed_thinking_levels: string[] }>).find(item => item.id === modelId);
		if (!profile) return { warning: false, blocked: true, action: "block_model" as const };
		if (!profile.allowed_thinking_levels.includes(thinkingLevel)) return { warning: false, blocked: true, action: "block_model" as const };
		const { data: auth, error: authError } = await this.client.auth.getSession();
		if (authError || !auth.session?.access_token) throw authError ?? new Error("Student sign-in required.");
		this.refreshGatewayToken?.(auth.session.access_token, sessionId, thinkingLevel);
		const decision = await this.client.rpc("check_model_budget", { project_id_input: projectId, profile_id_input: profile.id });
		if (decision.error) throw decision.error;
		return decision.data as { warning: boolean; blocked: boolean; action?: "block_model" | "fallback" | "block_ai" };
	}
}
