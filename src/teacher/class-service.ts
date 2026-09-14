import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readTeacherContext, writeTeacherContext } from "../telemetry/local-store.js";
import type { ProjectBrief, ProjectDraft } from "./project-builder.js";
import { parseCapabilityPolicy } from "../education/capability-policy.js";

export async function updateProjectCapabilities(client: SupabaseClient, projectId: string, policy: unknown): Promise<void> {
	const { error } = await client.from("projects").update({ capability_policy: parseCapabilityPolicy(policy) }).eq("id", projectId);
	if (error) throw error;
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

export async function joinClass(client: SupabaseClient, code: string): Promise<{ classId: string; status: "pending" | "active" }> {
	const normalized = normalizeJoinCode(code);
	const { data, error } = await client.rpc("join_class", { join_code_input: normalized });
	if (error) throw error;
	const row = Array.isArray(data) ? data[0] : data;
	if (!row?.class_id || !row?.membership_status) throw new Error("The class did not return a membership.");
	const context = await readTeacherContext();
	if (row.membership_status === "active") {
		await writeTeacherContext(context.classId === String(row.class_id) ? context : { classId: String(row.class_id) });
	}
	return { classId: String(row.class_id), status: row.membership_status === "active" ? "active" : "pending" };
}

export async function saveProjectDraft(client: SupabaseClient, classId: string, draft: ProjectDraft): Promise<{ id: string; name: string }> {
	const { data, error } = await client.from("projects").insert({
		class_id: classId,
		name: draft.name,
		description: draft.description || null,
		brief: draft.brief,
	}).select("id,name").single();
	if (error) throw error;
	for (let position = 0; position < draft.requirements.length; position += 1) {
		const requirement = draft.requirements[position]!;
		const result = await client.from("project_requirements").insert({ project_id: data.id, title: requirement.title, description: requirement.description || null, position });
		if (result.error) throw result.error;
	}
	for (const standard of draft.standards) {
		const standardResult = await client.from("standards").upsert({ class_id: classId, code: standard.code, title: standard.title || standard.code }, { onConflict: "class_id,code" }).select("id").single();
		if (standardResult.error) throw standardResult.error;
		const linkResult = await client.from("project_standards").upsert({ project_id: data.id, standard_id: standardResult.data.id }, { onConflict: "project_id,standard_id", ignoreDuplicates: true });
		if (linkResult.error) throw linkResult.error;
	}
	return { id: data.id, name: data.name };
}

export async function updateProjectBrief(client: SupabaseClient, projectId: string, values: { name: string; description: string | null; brief: ProjectBrief }): Promise<void> {
	const { error } = await client.from("projects").update(values).eq("id", projectId);
	if (error) throw error;
}
