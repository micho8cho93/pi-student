import type { ExecutionScope, ExecutionScopeProvider } from "@pi-student/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Uses the existing project → class → organization relationship and active membership. */
export class SupabaseExecutionScopeProvider implements ExecutionScopeProvider {
	constructor(private readonly client: SupabaseClient) {}

	async resolve(projectId: string): Promise<ExecutionScope> {
		const { data: auth, error: authError } = await this.client.auth.getUser();
		if (authError || !auth.user) throw new Error("Sign in before using a class project.");
		const { data: project, error: projectError } = await this.client.from("projects")
			.select("class_id,classes(organization_id)").eq("id", projectId).maybeSingle();
		if (projectError || !project) throw new Error("Selected project is unavailable.");
		if (typeof project.class_id !== "string" || !project.class_id) throw new Error("Selected project has no valid class scope.");
		const classId = project.class_id;
		const { data: membership, error: memberError } = await this.client.from("class_members")
			.select("status").eq("class_id", classId).eq("user_id", auth.user.id).eq("role", "student").maybeSingle();
		if (memberError || membership?.status !== "active") throw new Error("Active class membership is required.");
		const classes = project.classes as unknown as { organization_id: string | null } | Array<{ organization_id: string | null }> | null;
		const projectClass = Array.isArray(classes) ? classes[0] : classes;
		if (!projectClass || (projectClass.organization_id !== null && typeof projectClass.organization_id !== "string")) {
			throw new Error("Selected project's class scope is unavailable.");
		}
		const organizationId = projectClass.organization_id ?? undefined;
		if (organizationId) {
			// This RPC checks active organizational membership and project access.
			const { data, error } = await this.client.rpc("governance_context", { project_id_input: projectId });
			if (error || !data || data.classId !== classId || data.organizationId !== organizationId) {
				throw new Error("Managed project scope could not be validated.");
			}
		}
		return { projectId, classId, ...(organizationId ? { organizationId } : {}), userId: auth.user.id };
	}
}
