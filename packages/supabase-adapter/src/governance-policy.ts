import type { CapabilityPolicy, EffectivePolicy, ModelProfile, PolicyContext, PolicyProvider } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY, parseCapabilityPolicy } from "@pi-student/policy/capability-policy";
import { resolveEffectivePolicy, type PolicyLayer, type PolicyPatch } from "@pi-student/policy/resolution";
import type { SupabaseClient } from "@supabase/supabase-js";

interface ContextRow {
	organizationId: string;
	classId: string;
	project: { version: number; settings: CapabilityPolicy };
	layers: Array<{ scope: "organization" | "class" | "project"; version: number; settings: PolicyPatch; delegatedPaths: string[] }>;
}

function changedProjectSettings(settings: CapabilityPolicy): PolicyPatch {
	const patch: PolicyPatch = {};
	for (const key of ["fileEditing", "terminal", "dependencyInstallation", "internet", "desktopExport", "imageUploads", "fileUploads", "reflection"] as const) {
		if (settings[key] !== DEFAULT_CAPABILITY_POLICY[key]) patch[key] = settings[key];
	}
	if (settings.models.length) patch.models = settings.models;
	if (JSON.stringify(settings.reasoningLevels) !== JSON.stringify(DEFAULT_CAPABILITY_POLICY.reasoningLevels)) patch.reasoningLevels = settings.reasoningLevels;
	for (const key of ["minutes", "turns", "tokens", "cost"] as const) {
		if (settings.limits[key] !== DEFAULT_CAPABILITY_POLICY.limits[key]) (patch.limits ??= {})[key] = settings.limits[key];
	}
	for (const key of ["dictation", "cloudDictation", "readAloud", "simplifiedVocabulary", "readableFormatting"] as const) {
		if (settings.accessibility[key] !== DEFAULT_CAPABILITY_POLICY.accessibility[key]) (patch.accessibility ??= {})[key] = settings.accessibility[key];
	}
	return patch;
}

/** Control-plane adapter. A managed project never falls back to a stale local policy. */
export class SupabaseGovernancePolicyProvider implements PolicyProvider {
	constructor(private readonly client: SupabaseClient, private readonly standalone: PolicyProvider,
		private readonly gateway?: { url: string; configure: (projectId: string, url: string, profiles: ModelProfile[], token: string) => void },
		private readonly directModels: () => Array<{ provider: string; id: string }> = () => []) {}
	async resolvePolicy(context: PolicyContext): Promise<EffectivePolicy | undefined> {
		const projectId = context.projectId;
		if (!projectId) return this.standalone.resolvePolicy(context);
		const { data: project, error: lookupError } = await this.client.from("projects")
			.select("class_id,capability_policy,policy_version,classes(organization_id)").eq("id", projectId).maybeSingle();
		if (lookupError) throw lookupError;
		if (!project) throw new Error("Project access is unavailable.");
		const classes = project.classes as unknown as { organization_id: string | null } | { organization_id: string | null }[] | null;
		const projectClass = Array.isArray(classes) ? classes[0] : classes;
		if (!projectClass || (projectClass.organization_id !== null && typeof projectClass.organization_id !== "string")) {
			throw new Error("Project class scope is unavailable.");
		}
		const organizationId = projectClass.organization_id;
		if (!organizationId) return { projectId, version: project.policy_version ?? 1,
			settings: parseCapabilityPolicy(project.capability_policy) };
		const [governance, profiles, providers] = await Promise.all([
			this.client.rpc("governance_context", { project_id_input: projectId }),
			this.client.rpc("approved_model_profiles", { project_id_input: projectId }),
			this.client.rpc("approved_provider_ids", { project_id_input: projectId }),
		]);
		if (governance.error) throw governance.error;
		if (profiles.error) throw profiles.error;
		if (providers.error) throw providers.error;
		const approvedProviders = new Set((providers.data as string[]) ?? []);
		const data = governance.data as ContextRow;
		if (!data || data.organizationId !== organizationId || data.classId !== project.class_id || !Array.isArray(data.layers) ||
			!data.project || !Array.isArray(profiles.data) || !Array.isArray(providers.data)) {
			throw new Error("Institutional policy scope is invalid.");
		}
		const rawProfiles = profiles.data as Array<{ id: string; organization_id: string; display_name: string; provider: string; provider_model: string; allowed_thinking_levels: ModelProfile["allowedThinkingLevels"]; available: boolean; fallback_profile_id: string | null; version: number }>;
		if (rawProfiles.some(profile => profile.organization_id !== organizationId)) throw new Error("Model profile belongs to another organization.");
		const { data: auth } = await this.client.auth.getSession();
		if (!auth.session?.access_token) throw new Error("Sign in before using institution models.");
		const modelProfiles: ModelProfile[] = rawProfiles.filter(profile => approvedProviders.has(profile.provider)).map(profile => ({ id: profile.id, organizationId: profile.organization_id,
			displayName: profile.display_name, provider: profile.provider, providerModel: profile.provider_model,
			allowedThinkingLevels: profile.allowed_thinking_levels, available: profile.available,
			fallbackProfileId: profile.fallback_profile_id ?? undefined, version: profile.version }));
		if (this.gateway && modelProfiles.length) this.gateway.configure(projectId, this.gateway.url, modelProfiles, auth.session.access_token);
		const models = [
			...(this.gateway ? modelProfiles.map(profile => `institution/${profile.id}`) : []),
			...this.directModels().filter(model => approvedProviders.has(model.provider)).map(model => `${model.provider}/${model.id}`),
		];
		const organization = data.layers.find(layer => layer.scope === "organization");
		const delegatedPaths = organization?.delegatedPaths ?? [];
		const selectedModels = organization?.settings.models?.length
			? models.filter(model => organization.settings.models!.includes(model))
			: models;
		// An empty allow list is a valid initial state. Leave model policy paths out
		// so the general resolver can still apply all other class restrictions.
		const modelSettings = (settings: PolicyPatch): PolicyPatch => selectedModels.length ? settings : { ...settings, models: undefined };
		const orgLayer: PolicyLayer = { scope: "organization", version: organization?.version ?? 1,
			settings: { ...organization?.settings, ...(selectedModels.length ? { models: selectedModels } : { models: undefined }) } };
		const classLayer = data.layers.find(layer => layer.scope === "class");
		const projectLayer = data.layers.find(layer => layer.scope === "project");
		const legacy = modelSettings(changedProjectSettings(data.project.settings));
		const resolved = resolveEffectivePolicy({ projectId, delegatedPaths, platform: { scope: "platform", version: 1, settings: {} }, organization: orgLayer,
			class: classLayer ? { scope: "class", version: classLayer.version, settings: modelSettings(classLayer.settings) } : undefined,
			project: { scope: "project", version: Math.max(projectLayer?.version ?? 1, data.project.version),
				settings: { ...legacy, ...modelSettings(projectLayer?.settings ?? {}),
					limits: { ...legacy.limits, ...projectLayer?.settings.limits },
					accessibility: { ...legacy.accessibility, ...projectLayer?.settings.accessibility } } } });
		return resolved;
	}
}
