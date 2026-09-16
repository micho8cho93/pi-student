import type { SupabaseClient } from "@supabase/supabase-js";
import type { ClassroomRepository, ClassSummary, ProjectSummary, ProjectBrief, ProjectDraft } from "@pi-student/classroom";
import { parseCapabilityPolicy } from "@pi-student/policy/capability-policy";

export class SupabaseClassroomRepository implements ClassroomRepository {
	constructor(readonly client: SupabaseClient) {}

	async joinClass(code: string) {
		const { data, error } = await this.client.rpc("join_class", { join_code_input: code });
		if (error) throw error;
		const row = Array.isArray(data) ? data[0] : data;
		if (!row?.class_id || !row?.membership_status) throw new Error("The class did not return a membership.");
		return { classId: String(row.class_id), status: row.membership_status === "active" ? "active" as const : "pending" as const };
	}

	async listClasses(): Promise<ClassSummary[]> {
		const { data: auth, error: authError } = await this.client.auth.getUser();
		if (authError || !auth.user) throw authError ?? new Error("Sign in before listing classes.");
		const { data, error } = await this.client.from("class_members").select("class_id,status,classes(name)").eq("user_id", auth.user.id).eq("role", "student").order("joined_at");
		if (error) throw error;
		return data.map(item => ({ id: String(item.class_id), name: relation(item.classes)?.name ?? "Class", status: item.status as ClassSummary["status"] }));
	}

	async getClass(classId: string): Promise<ClassSummary | undefined> { return (await this.listClasses()).find(item => item.id === classId); }

	async listProjects(classId: string): Promise<ProjectSummary[]> {
		const { data, error } = await this.client.from("projects")
			.select("id,class_id,name,description,brief,capability_policy,policy_version,classes(organization_id),project_requirements(id,title,description,position),project_standards(standards(id,code,title))")
			.eq("class_id", classId).order("created_at", { ascending: false });
		if (error) throw error;
		return (data as unknown[]).map(row => mapProject(row as ProjectRow));
	}

	async getProject(projectId: string): Promise<ProjectSummary | undefined> {
		const { data, error } = await this.client.from("projects")
			.select("id,class_id,name,description,brief,capability_policy,policy_version,classes(organization_id),project_requirements(id,title,description,position),project_standards(standards(id,code,title))")
			.eq("id", projectId).maybeSingle();
		if (error) throw error;
		return data ? mapProject(data as unknown as ProjectRow) : undefined;
	}

	async saveProjectDraft(classId: string, draft: ProjectDraft): Promise<{ id: string; name: string }> {
		const { data, error } = await this.client.from("projects").insert({ class_id: classId, name: draft.name, description: draft.description || null, brief: draft.brief }).select("id,name").single();
		if (error) throw error;
		for (let position = 0; position < draft.requirements.length; position += 1) {
			const requirement = draft.requirements[position]!;
			const result = await this.client.from("project_requirements").insert({ project_id: data.id, title: requirement.title, description: requirement.description || null, position });
			if (result.error) throw result.error;
		}
		for (const standard of draft.standards) {
			const standardResult = await this.client.from("standards").upsert({ class_id: classId, code: standard.code, title: standard.title || standard.code }, { onConflict: "class_id,code" }).select("id").single();
			if (standardResult.error) throw standardResult.error;
			const linkResult = await this.client.from("project_standards").upsert({ project_id: data.id, standard_id: standardResult.data.id }, { onConflict: "project_id,standard_id", ignoreDuplicates: true });
			if (linkResult.error) throw linkResult.error;
		}
		return { id: String(data.id), name: String(data.name) };
	}

	async updateProjectBrief(projectId: string, values: { name: string; description: string | null; brief: ProjectBrief }): Promise<void> {
		const { error } = await this.client.from("projects").update(values).eq("id", projectId); if (error) throw error;
	}

	async updateProjectCapabilities(projectId: string, policy: unknown): Promise<void> {
		const { error } = await this.client.from("projects").update({ capability_policy: parseCapabilityPolicy(policy) }).eq("id", projectId); if (error) throw error;
	}
}

type Relation<T> = T | T[] | null;
interface ProjectRow { id: string; class_id: string; name: string; description: string | null; classes?: Relation<{ organization_id: string | null }>; brief?: Partial<ProjectBrief> | null; capability_policy?: unknown; policy_version?: number; project_requirements?: Array<{ id: string; title: string; description?: string; position: number }>; project_standards?: Array<{ standards: Relation<{ id: string; code?: string; title?: string }> }> }
function relation<T>(value: Relation<T>): T | undefined { return Array.isArray(value) ? value[0] : value ?? undefined; }
function mapProject(row: ProjectRow): ProjectSummary {
	return {
		id: String(row.id), classId: String(row.class_id), ...(relation(row.classes)?.organization_id ? { organizationId: relation(row.classes)!.organization_id! } : {}), name: row.name, description: row.description, brief: row.brief,
		policy: { projectId: String(row.id), version: row.policy_version ?? 1, settings: parseCapabilityPolicy(row.capability_policy) },
		requirements: [...(row.project_requirements ?? [])].sort((a, b) => a.position - b.position),
		standards: (row.project_standards ?? []).flatMap(link => { const value = relation(link.standards); return value ? [value] : []; }),
	};
}
