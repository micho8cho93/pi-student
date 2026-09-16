import process from "node:process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authenticateInBrowser, createPiSupabaseClient, createSupabaseLearningRecordUploader, readSupabaseConfig, SupabaseClassroomRepository } from "@pi-student/supabase-adapter";
import { joinClass } from "@pi-student/classroom/class-service";
import { startTeacherDashboard } from "./dashboard-server.js";
import { LearningRecordStore, readTeacherContext, writeTeacherContext } from "@pi-student/telemetry/local-store";
import { LearningRecordSyncService } from "@pi-student/telemetry/sync-service";
import { describeAuthError } from "@pi-student/classroom/auth-flow";
import { runTeacherTui } from "./tui.js";

export async function runTeacherCommand(args: string[]): Promise<boolean> {
	const [area, action, ...rest] = args;
	if (area === "teacher") {
		if (action === "auth") return runAuthCommand(rest);
		if (action === "class") return runTeacherClassCommand(rest);
		if (action === "project") return runTeacherProjectCommand(rest);
		if (!action || action === "tui" || action === "terminal" || action === "--port") {
			const flags = action === "--port" ? [action, ...rest] : rest;
			await startTeacherTui(flags);
			return true;
		}
		if (action === "web") {
			await startTeacherDashboard({ port: readTeacherPort(rest) });
			return true;
		}
		throw new Error("Usage: pi-student teacher [tui] [--port <number>] or pi-student teacher web [--port <number>]");
	}
	if (area === "auth") {
		return runAuthCommand([action, ...rest]);
	}
	if (area === "class") {
		const client = createPiSupabaseClient(requireConfig());
		if (action === "join") {
			const code = rest[0];
			if (!code) throw new Error("Usage: pi-student class join ABC-234");
			const membership = await joinClass(new SupabaseClassroomRepository(client), code);
			process.stdout.write(membership.status === "active"
				? "Class joined. Future learning records can sync for this class.\n"
				: "Join request sent. Your teacher must approve it before records sync.\n");
			return true;
		}
		if (action === "list") {
			const { data, error } = await client.from("class_members").select("class_id,status,classes(name)").eq("role", "student").order("joined_at");
			if (error) throw new Error(describeAuthError(error));
			for (const membership of data) {
				const relation = membership.classes as unknown as { name: string } | Array<{ name: string }> | null;
				const name = Array.isArray(relation) ? relation[0]?.name : relation?.name;
				process.stdout.write(`${membership.class_id}  ${name ?? "Class"}  (${membership.status})\n`);
			}
			return true;
		}
		if (action === "select") {
			const classId = rest[0];
			if (!classId) throw new Error("Usage: pi-student class select <class-id>");
			const { data: auth, error: authError } = await client.auth.getUser();
			if (authError || !auth.user) throw authError ?? new Error("Sign in before selecting a class.");
			const { data, error } = await client.from("class_members").select("class_id").eq("class_id", classId).eq("user_id", auth.user.id).eq("status", "active").eq("role", "student").maybeSingle();
			if (error) throw new Error(describeAuthError(error));
			if (!data) throw new Error("You do not have an active student membership in that class.");
			await writeTeacherContext({ classId: data.class_id });
			process.stdout.write("Active class selected. Choose a project next.\n");
			return true;
		}
		throw new Error("Usage: pi-student class [join <code>|list|select <class-id>]");
	}
	if (area === "project") {
		const client = createPiSupabaseClient(requireConfig());
		const context = await readTeacherContext();
		if (!context.classId) throw new Error("Join a class before selecting a project.");
		if (action === "list") {
			const { data, error } = await client.from("projects").select("id,name,project_requirements(id,title),project_standards(standards(id,code))").eq("class_id", context.classId).order("created_at");
			if (error) throw error;
			for (const project of data) process.stdout.write(`${project.id}  ${project.name}\n`);
			return true;
		}
		if (action === "select") {
			const projectId = rest[0];
			if (!projectId) throw new Error("Usage: pi-student project select <project-id> [--requirements id,id]");
			const { data, error } = await client.from("projects").select("id,name,project_requirements(id),project_standards(standards(id))").eq("id", projectId).eq("class_id", context.classId).single();
			if (error) throw error;
			const requested = rest[1] === "--requirements" ? (rest[2] ?? "").split(",").filter(Boolean) : [];
			const available = new Set((data.project_requirements ?? []).map(item => item.id));
			if (requested.some(id => !available.has(id))) throw new Error("One or more requirements do not belong to this project.");
			const links = (data.project_standards ?? []) as unknown as Array<{ standards: { id: string } | Array<{ id: string }> | null }>;
			const standardIds = links.map(link => Array.isArray(link.standards) ? link.standards[0]?.id : link.standards?.id).filter((id): id is string => Boolean(id));
			await writeTeacherContext({ classId: context.classId, projectId: data.id, requirementIds: requested, standardIds });
			process.stdout.write(`Selected ${data.name}. ${standardIds.length} project standard(s) will be associated automatically.\n`);
			return true;
		}
		throw new Error("Usage: pi-student project [list|select <project-id>]");
	}
	if (area === "sync") {
		const client = createPiSupabaseClient(requireConfig());
		const result = await new LearningRecordSyncService(new LearningRecordStore(), createSupabaseLearningRecordUploader(client)).syncPending();
		process.stdout.write(`Learning records: ${result.synced} synced, ${result.failed} deferred, ${result.skipped} standalone.\n`);
		return true;
	}
	return false;
}

async function startTeacherTui(flags: string[]): Promise<void> {
	const port = readTeacherPort(flags);
	const server = await startTeacherDashboard({ port, open: false });
	try {
		await runTeacherTui(requireConfig(), { webUrl: `http://127.0.0.1:${port}` });
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

export function readTeacherPort(flags: string[]): number {
	const portIndex = flags.indexOf("--port");
	if (portIndex < 0) return 4173;
	const port = Number(flags[portIndex + 1]);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Teacher dashboard port must be an integer from 1 to 65535.");
	return port;
}

function requireConfig() {
	const config = readSupabaseConfig();
	if (!config) throw new Error("Classroom integration is not configured. Set PI_STUDENT_SUPABASE_URL and PI_STUDENT_SUPABASE_PUBLISHABLE_KEY.");
	return config;
}

async function runAuthCommand(args: string[]): Promise<boolean> {
	const [action, ...rest] = args;
	const client = createPiSupabaseClient(requireConfig());
	if (action === "status") {
		const { data, error } = await client.auth.getUser();
		if (error && !/session missing|auth session missing/i.test(error.message)) throw error;
		process.stdout.write(data.user ? `Signed in as ${data.user.email ?? data.user.id}.\n` : "Not signed in.\n");
		return true;
	}
	if (action === "logout") {
		const { error } = await client.auth.signOut();
		if (error) throw error;
		process.stdout.write("Signed out of the classroom service.\n");
		return true;
	}
	if (action === "verify" && rest[0] === "email") {
		const email = rest[1];
		const token = rest[2];
		if (!email || !token) throw new Error("Usage: pi-student auth verify email <address> <6-digit-code>");
		const { error } = await client.auth.verifyOtp({ email, token, type: "email" });
		if (error) throw error;
		process.stdout.write("Email code verified. Signed in to the classroom service.\n");
		return true;
	}
	if (action === "login") {
		const method = rest[0] === "google" ? "google" : "email";
		const email = method === "email" ? (rest[0] === "email" ? rest[1] : rest[0]) : undefined;
		if (method === "email" && !email) throw new Error("Usage: pi-student auth login email teacher@example.edu");
		await authenticateInBrowser(client, method, email);
		return true;
	}
	throw new Error("Usage: pi-student auth [login email <address>|login google|verify email <address> <code>|status|logout]");
}

async function runTeacherClassCommand(args: string[]): Promise<boolean> {
	const [action, ...rest] = args;
	const client = createPiSupabaseClient(requireConfig());
	const user = await requireSignedIn(client);
	if (action === "create") {
		const name = rest.join(" ").trim();
		if (!name) throw new Error("Usage: pi-student teacher class create <class-name>");
		const { data, error } = await client.from("classes").insert({ name, teacher_id: user.id }).select("id,name,join_code,join_code_expires_at").single();
		if (error) throw error;
		process.stdout.write(`Class created: ${data.name}\nID: ${data.id}\nJoin code: ${data.join_code}\n`);
		return true;
	}
	if (action === "list") {
		const { data, error } = await client.from("classes").select("id,name,join_code,join_enabled,join_code_expires_at,created_at").eq("teacher_id", user.id).order("created_at");
		if (error) throw error;
		if (!data.length) process.stdout.write("No classes yet.\n");
		for (const item of data) process.stdout.write(`${item.id}  ${item.name}  ${item.join_enabled ? item.join_code : "joining paused"}\n`);
		return true;
	}
	if (action === "members") {
		const classId = rest[0];
		if (!classId) throw new Error("Usage: pi-student teacher class members <class-id>");
		const { data, error } = await client.from("class_members").select("id,user_id,role,status,joined_at,profiles(display_name,email)").eq("class_id", classId).order("joined_at");
		if (error) throw error;
		for (const member of data) {
			const profile = member.profiles as unknown as { display_name?: string; email?: string } | Array<{ display_name?: string; email?: string }> | null;
			const person = Array.isArray(profile) ? profile[0] : profile;
			process.stdout.write(`${member.id}  ${person?.display_name ?? person?.email ?? member.user_id}  ${member.role}  ${member.status}\n`);
		}
		return true;
	}
	if (action === "approve" || action === "reject") {
		const membershipId = rest[0];
		if (!membershipId) throw new Error(`Usage: pi-student teacher class ${action} <membership-id>`);
		const { data, error } = await client.from("class_members").update({ status: action === "approve" ? "active" : "rejected" }).eq("id", membershipId).select("status").single();
		if (error) throw error;
		process.stdout.write(`Membership ${membershipId}: ${data.status}.\n`);
		return true;
	}
	if (action === "regenerate") {
		const classId = rest[0];
		if (!classId) throw new Error("Usage: pi-student teacher class regenerate <class-id>");
		const { data, error } = await client.rpc("regenerate_class_join_code", { class_id_input: classId, expires_at_input: null });
		if (error) throw error;
		const row = Array.isArray(data) ? data[0] : data;
		process.stdout.write(`New join code: ${row?.join_code ?? " unavailable"}\n`);
		return true;
	}
	if (action === "pause" || action === "resume") {
		const classId = rest[0];
		if (!classId) throw new Error(`Usage: pi-student teacher class ${action} <class-id>`);
		const { error } = await client.from("classes").update({ join_enabled: action === "resume" }).eq("id", classId).eq("teacher_id", user.id);
		if (error) throw error;
		process.stdout.write(`Class joining ${action === "resume" ? "enabled" : "paused"}.\n`);
		return true;
	}
	throw new Error("Usage: pi-student teacher class [create <name>|list|members <class-id>|approve <membership-id>|reject <membership-id>|regenerate <class-id>|pause <class-id>|resume <class-id>]");
}

async function runTeacherProjectCommand(args: string[]): Promise<boolean> {
	const [action, ...rest] = args;
	const client = createPiSupabaseClient(requireConfig());
	await requireSignedIn(client);
	if (action === "list") {
		const classId = rest[0];
		if (!classId) throw new Error("Usage: pi-student teacher project list <class-id>");
		const { data, error } = await client.from("projects").select("id,name,description,project_requirements(id,title),project_standards(standards(code,title))").eq("class_id", classId).order("created_at");
		if (error) throw error;
		for (const project of data) {
			const requirements = (project.project_requirements ?? []).map(item => item.title).join("; ") || "no requirements";
			const standards = ((project.project_standards ?? []) as unknown as Array<{ standards: { code: string } | Array<{ code: string }> | null }>).map(item => Array.isArray(item.standards) ? item.standards[0]?.code : item.standards?.code).filter(Boolean).join(", ") || "no standards";
			process.stdout.write(`${project.id}  ${project.name}\n  Requirements: ${requirements}\n  Standards: ${standards}\n`);
		}
		return true;
	}
	if (action === "create") {
		const classId = rest[0];
		const name = rest.slice(1).join(" ").trim();
		if (!classId || !name) throw new Error("Usage: pi-student teacher project create <class-id> <project-name>");
		const { data, error } = await client.from("projects").insert({ class_id: classId, name }).select("id,name").single();
		if (error) throw error;
		process.stdout.write(`Project created: ${data.name}\nID: ${data.id}\n`);
		return true;
	}
	if (action === "requirement") {
		const projectId = rest[0];
		const title = rest.slice(1).join(" ").trim();
		if (!projectId || !title) throw new Error("Usage: pi-student teacher project requirement <project-id> <title>");
		const { data, error } = await client.from("project_requirements").insert({ project_id: projectId, title }).select("id,title").single();
		if (error) throw error;
		process.stdout.write(`Requirement added: ${data.title}\nID: ${data.id}\n`);
		return true;
	}
	if (action === "standard") {
		const classId = rest[0];
		const projectId = rest[1];
		const code = rest[2];
		const title = rest.slice(3).join(" ").trim() || code;
		if (!classId || !projectId || !code) throw new Error("Usage: pi-student teacher project standard <class-id> <project-id> <code> [title]");
		const { data, error } = await client.from("standards").upsert({ class_id: classId, code, title }, { onConflict: "class_id,code" }).select("id,code").single();
		if (error) throw error;
		const { error: linkError } = await client.from("project_standards").upsert({ project_id: projectId, standard_id: data.id }, { onConflict: "project_id,standard_id", ignoreDuplicates: true });
		if (linkError) throw linkError;
		process.stdout.write(`Standard linked: ${data.code}\n`);
		return true;
	}
	throw new Error("Usage: pi-student teacher project [list <class-id>|create <class-id> <name>|requirement <project-id> <title>|standard <class-id> <project-id> <code> [title]]");
}

async function requireSignedIn(client: SupabaseClient) {
	const { data, error } = await client.auth.getUser();
	if (error || !data.user) throw error ?? new Error("Sign in first with pi-student teacher auth login google or pi-student teacher auth login email <address>.");
	return data.user;
}
