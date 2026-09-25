import { FileTeacherContextStore } from "@pi-student/telemetry/local-store";
import { createPiSupabaseClient } from "./auth.js";
import { readSupabaseConfig } from "./config.js";

/** The active managed project determines which BYOK providers may be connected. */
export async function approvedProvidersForCurrentProject(): Promise<string[] | undefined> {
	const config = readSupabaseConfig();
	const projectId = (await new FileTeacherContextStore().read()).projectId;
	if (!config || !projectId) return undefined;
	const client = createPiSupabaseClient(config);
	const { data: project, error: lookupError } = await client.from("projects")
		.select("class_id,classes(organization_id)").eq("id", projectId).maybeSingle();
	if (lookupError) throw lookupError;
	if (!project) throw new Error("Selected project is unavailable.");
	const classes = project.classes as unknown as { organization_id: string | null } | Array<{ organization_id: string | null }> | null;
	if (!(Array.isArray(classes) ? classes[0] : classes)?.organization_id) return undefined;
	const { data, error } = await client.rpc("approved_provider_ids", { project_id_input: projectId });
	if (error) throw error;
	if (!Array.isArray(data) || !data.every(id => typeof id === "string")) throw new Error("Invalid provider approval response.");
	return data;
}

export async function currentPiUserId(): Promise<string> {
	const config = readSupabaseConfig();
	if (!config) throw new Error("Sign in to Pi Student before connecting Supabase MCP.");
	const { data, error } = await createPiSupabaseClient(config).auth.getUser();
	if (error || !data.user) throw new Error("Sign in to Pi Student before connecting Supabase MCP.");
	return data.user.id;
}

export async function supabaseMcpAvailableForCurrentProject(): Promise<boolean> {
	const config = readSupabaseConfig();
	const projectId = (await new FileTeacherContextStore().read()).projectId;
	if (!config || !projectId) return false;
	const { data, error } = await createPiSupabaseClient(config).rpc("resolve_institutional_environment", { project_id_input: projectId });
	if (error) throw error;
	return Array.isArray(data?.mcps) && data.mcps.some((item: { endpoint?: string }) => item.endpoint === "https://mcp.supabase.com/mcp");
}
