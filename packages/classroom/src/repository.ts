import type { ClassId, EffectivePolicy, MembershipStatus, ProjectId } from "@pi-student/contracts";
import type { ProjectBrief, ProjectDraft } from "./project-builder.js";

export interface ClassSummary {
	id: ClassId;
	name: string;
	status: MembershipStatus;
}

export interface ProjectRequirement { id: string; title: string; description?: string; position: number }
export interface ProjectStandard { id: string; code?: string; title?: string }

export interface ProjectSummary {
	id: ProjectId;
	classId: ClassId;
	organizationId?: string;
	name: string;
	description: string | null;
	brief?: Partial<ProjectBrief> | null;
	policy?: EffectivePolicy;
	requirements: ProjectRequirement[];
	standards: ProjectStandard[];
}

export interface JoinClassResult { classId: ClassId; status: Extract<MembershipStatus, "pending" | "active"> }

/** Backend-neutral operations used by the student runtime and project builder. */
export interface ClassroomRepository {
	joinClass(code: string): Promise<JoinClassResult>;
	listClasses(): Promise<ClassSummary[]>;
	getClass(classId: ClassId): Promise<ClassSummary | undefined>;
	listProjects(classId: ClassId): Promise<ProjectSummary[]>;
	getProject(projectId: ProjectId): Promise<ProjectSummary | undefined>;
	saveProjectDraft(classId: ClassId, draft: ProjectDraft): Promise<{ id: ProjectId; name: string }>;
	updateProjectBrief(projectId: ProjectId, values: { name: string; description: string | null; brief: ProjectBrief }): Promise<void>;
	updateProjectCapabilities(projectId: ProjectId, policy: unknown): Promise<void>;
}
