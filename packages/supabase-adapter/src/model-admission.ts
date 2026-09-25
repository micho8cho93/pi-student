import type { BudgetPurpose, ModelAdmissionDecision, ModelAdmissionProvider, ThinkingLevel } from "@pi-student/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export class SupabaseModelAdmissionProvider implements ModelAdmissionProvider {
	constructor(private readonly client: SupabaseClient, private readonly refreshGatewayToken?: (token: string, sessionId?: string, thinkingLevel?: ThinkingLevel) => void) {}
	async check(projectId: string, provider: string, modelId: string, thinkingLevel: ThinkingLevel, sessionId?: string, purpose: BudgetPurpose = "agent"): Promise<ModelAdmissionDecision> {
		const refused = { warning: false, blocked: true, agentBlocked: true, action: "block_model" as const };
		if (provider !== "institution") {
			const approved = await this.client.rpc("approved_provider_ids", { project_id_input: projectId });
			if (approved.error) throw approved.error;
			return (approved.data as string[]).includes(provider) ? { warning: false, blocked: false, agentBlocked: false } : refused;
		}
		const profiles = await this.client.rpc("approved_model_profiles", { project_id_input: projectId });
		if (profiles.error) throw profiles.error;
		const profile = (profiles.data as Array<{ id: string; provider: string; provider_model: string; allowed_thinking_levels: string[] }>).find(item => item.id === modelId);
		if (!profile) return refused;
		if (!profile.allowed_thinking_levels.includes(thinkingLevel)) return refused;
		const { data: auth, error: authError } = await this.client.auth.getSession();
		if (authError || !auth.session?.access_token) throw authError ?? new Error("Student sign-in required.");
		this.refreshGatewayToken?.(auth.session.access_token, sessionId, thinkingLevel);
		const decision = await this.client.rpc("check_model_budget", { project_id_input: projectId, profile_id_input: profile.id });
		if (decision.error) throw decision.error;
		const data = decision.data as { warning: boolean; blocked: boolean; agentBlocked?: boolean; action?: ModelAdmissionDecision["action"] };
		// Servers without the reserve report only blocked; treat it as closing every lane.
		const agentBlocked = data.agentBlocked ?? data.blocked;
		if (purpose === "agent" && agentBlocked && !data.blocked) return { warning: true, blocked: true, agentBlocked, action: "assistance_only" };
		return { warning: data.warning, blocked: purpose === "agent" ? agentBlocked : data.blocked, agentBlocked, ...(data.action ? { action: data.action } : {}) };
	}
}
