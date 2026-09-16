import { randomBytes } from "node:crypto";
import type { ProjectBrief, ProjectDraft } from "./project-builder.js";
import type { ClassroomRepository, JoinClassResult, ProjectSummary } from "./repository.js";

export async function updateProjectCapabilities(repository: ClassroomRepository, projectId: string, policy: unknown): Promise<void> {
	await repository.updateProjectCapabilities(projectId, policy);
}

const JOIN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateJoinCode(random: (size: number) => Buffer = randomBytes): string {
	const bytes = random(6);
	const characters = Array.from(bytes, value => JOIN_ALPHABET[value % JOIN_ALPHABET.length]);
	return `${characters.slice(0, 3).join("")}-${characters.slice(3).join("")}`;
}

export function normalizeJoinCode(code: string): string {
	const normalized = code.trim().toUpperCase();
	if (!/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/.test(normalized)) throw new Error("Join code must look like ABC-234.");
	return normalized;
}

export function joinClass(repository: ClassroomRepository, code: string): Promise<JoinClassResult> {
	return repository.joinClass(normalizeJoinCode(code));
}

export function saveProjectDraft(repository: ClassroomRepository, classId: string, draft: ProjectDraft): Promise<{ id: string; name: string }> {
	return repository.saveProjectDraft(classId, draft);
}

export function updateProjectBrief(repository: ClassroomRepository, projectId: string, values: { name: string; description: string | null; brief: ProjectBrief }): Promise<void> {
	return repository.updateProjectBrief(projectId, values);
}

export function listClasses(repository: ClassroomRepository) { return repository.listClasses(); }
export function listProjects(repository: ClassroomRepository, classId: string): Promise<ProjectSummary[]> { return repository.listProjects(classId); }
