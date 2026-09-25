import { editCapabilities } from "./capability-tui.js";
import { updateProjectCapabilities, saveProjectDraft, updateProjectBrief } from "@pi-student/classroom/class-service";
import process from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTheme, renderPanel, type PanelRow, type TerminalTheme } from "@pi-student/runtime/ui";
import { createPiSupabaseClient, SupabaseClassroomRepository, type SupabaseConfig } from "@pi-student/supabase-adapter";
import { describeAuthError } from "@pi-student/classroom/auth-flow";
import { openBrowser } from "./open-browser.js";
import { DictationController } from "@pi-student/runtime/dictation";
import { runDictationSetup, type DictationSetupUI } from "@pi-student/runtime/dictation-setup";
import { execFileSync } from "node:child_process";
import { formatProjectBrief, normalizeProjectBrief, type ProjectBrief } from "@pi-student/classroom/project-builder";

type Relation<T> = T | T[] | null;
type Profile = { display_name?: string | null; email?: string | null };
type TeacherClass = { id: string; name: string; organization_id?: string | null; join_code: string; join_enabled: boolean; join_code_expires_at?: string | null; class_members?: Array<{ count: number }> };
type Member = { id: string; user_id: string; role: string; status: string; joined_at: string; profiles: Relation<Profile> };
type Project = { capability_policy?: unknown; policy_version?: number; id: string; name: string; description?: string | null; brief?: Partial<ProjectBrief> | null; project_requirements?: Array<{ id: string; title: string }>; project_standards?: Array<{ standards: Relation<{ id?: string; code: string; title?: string }> }> };
type Session = Record<string, unknown> & { id: string; student_id: string; started_at: string; duration_seconds: number; total_tokens: number; files_created: number; files_modified: number; files_deleted: number; goal?: string | null; models?: string[]; blockers?: string[]; planning_assistance?: string; implementation_assistance?: string; debugging_assistance?: string; explanation_assistance?: string; decisions?: string[]; thinking_mode?: string | null; profiles?: Relation<Profile>; projects?: Relation<{ name: string }>; session_reflections?: Array<Record<string, string>>; session_requirements?: Array<{ project_requirements: Relation<{ title: string }> }>; session_standards?: Array<{ standards: Relation<{ code: string }> }> };

export interface TeacherTuiOptions {
	client?: SupabaseClient;
	input?: Readable;
	output?: Writable;
	themeName?: string;
	now?: () => Date;
	webUrl?: string;
}

type Screen =
	| { kind: "classes" }
	| { kind: "class"; item: TeacherClass; tab: "today" | "students" | "projects" }
	| { kind: "student"; item: TeacherClass; studentId: string; profile: Profile | null; range: "today" | "week" | "project" };

/** Interactive, keyboard-first counterpart to the browser teacher dashboard. */
export async function runTeacherTui(config: SupabaseConfig, options: TeacherTuiOptions = {}): Promise<void> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const client = options.client ?? createPiSupabaseClient(config);
	const theme = createTheme(output, options.themeName);
	const readline = createInterface({ input, output, terminal: Boolean((input as Readable & { isTTY?: boolean }).isTTY) });
	const write = (value: string) => output.write(value);
	const dictation = new DictationController();
	const dictationSetupUI = createTeacherDictationSetupUI(readline, input, output, theme, write);
	let remoteDictationConsent = false;
	const state: { screen: Screen; choices: Array<{ type: "class"; item: TeacherClass } | { type: "student"; id: string; profile: Profile | null } | { type: "member"; item: Member } | { type: "project"; item: Project }> } = { screen: { kind: "classes" }, choices: [] };

	try {
		const { data, error } = await client.auth.getUser();
		if (error || !data.user) throw new Error(describeAuthError(error ?? new Error("Not signed in.")) + " Sign in with `pi-student teacher auth login google`, then try again.");
		write(`${theme.dim(`Signed in as ${data.user.email ?? data.user.id}`)}\n`);
		let running = true;
		while (running) {
			try {
				state.choices = await renderScreen(client, state.screen, theme, write, options.now ?? (() => new Date()), Boolean((output as Writable & { isTTY?: boolean }).isTTY), options.webUrl);
				let raw = (await readline.question(theme.accent("\nteacher › "))).trim();
				if (!raw) continue;
				let [command, ...args] = splitCommand(raw);
				if (["dictation", "/dictation"].includes(command)) {
					await runDictationSetup(dictation, dictationSetupUI);
					await pause(readline);
					continue;
				}
				if (["dictate", "/dictate", "voice", "/voice"].includes(command)) {
					const backend = await dictation.getBackend() ?? await runDictationSetup(dictation, dictationSetupUI);
					if (!backend) continue;
					if (backend.remote && !remoteDictationConsent) {
						const answer = await readline.question(theme.warning(`Your recording will be sent to ${backend.label} for transcription. Continue? [y/N] `));
						if (!/^(y|yes)$/iu.test(answer.trim())) continue;
						remoteDictationConsent = true;
					}
					await dictation.start();
					await readline.question(theme.success(`Listening with ${backend.label}. Speak a dashboard command, then press Enter to stop. `));
					write(`${theme.dim("Transcribing…")}\n`);
					raw = (await dictation.stop()).trim();
					write(`${theme.accent("Heard")} ${raw}\n`);
					[command, ...args] = splitCommand(raw);
					if (!command) continue;
				}
				if (["q", "quit", "exit"].includes(command)) { running = false; continue; }
				if (["h", "help", "?"].includes(command)) { write(`${renderHelp(theme)}\n`); await pause(readline); continue; }
				if (["r", "refresh"].includes(command)) continue;
				if (command === "web" && options.webUrl) { openBrowser(options.webUrl); continue; }
				if (["b", "back"].includes(command)) { state.screen = backScreen(state.screen); continue; }
				await handleInput(client, state, command, args, readline, theme, write);
			} catch (error) {
				write(`\n${theme.error("Could not update the dashboard.")} ${describeAuthError(error)}\n`);
				await pause(readline);
			}
		}
	} finally {
		await dictation.cancel();
		readline.close();
		write(`${theme.dim("Teacher dashboard closed.")}\n`);
	}
}

async function renderScreen(client: SupabaseClient, screen: Screen, theme: TerminalTheme, write: (value: string) => void, now: () => Date, interactive: boolean, webUrl?: string) {
	clear(write, interactive);
	write(`${renderPanel(theme, "Pi Student · teacher dashboard", [
		{ label: "view", value: breadcrumb(screen), tone: "accent" },
		...(webUrl ? [{ label: "browser", value: `${webUrl} · type web to open`, tone: "accent" as const }] : []),
		{ label: "navigate", value: "type a number or short command" },
		{ label: "voice", value: "/dictate · /dictation setup", tone: "accent" },
	])}\n`);
	if (screen.kind === "classes") return renderClasses(client, theme, write);
	if (screen.kind === "class" && screen.tab === "today") return renderToday(client, screen.item, theme, write, now);
	if (screen.kind === "class" && screen.tab === "students") return renderMembers(client, screen.item, theme, write);
	if (screen.kind === "class") return renderProjects(client, screen.item, theme, write);
	return renderStudent(client, screen, theme, write, now);
}

async function renderClasses(client: SupabaseClient, theme: TerminalTheme, write: (value: string) => void) {
	const { data, error } = await client.from("classes").select("id,name,organization_id,join_code,join_enabled,join_code_expires_at,class_members(count)").order("created_at");
	if (error) throw error;
	const classes = (data ?? []) as unknown as TeacherClass[];
	write(`\n${theme.bold("MY CLASSES")}  ${theme.dim("A quiet view into how students are learning.")}\n`);
	if (!classes.length) write(`${renderPanel(theme, "No classes yet", [{ label: "next", value: "type new to create your first class", tone: "accent" }])}\n`);
	classes.forEach((item, index) => write(`${renderPanel(theme, `${index + 1} · ${item.name}`, [
		{ label: "students", value: String(Math.max(0, Number(item.class_members?.[0]?.count ?? 0) - 1)) },
		{ label: "join code", value: item.join_enabled ? item.join_code : "joining paused", tone: item.join_enabled ? "accent" : "warning" },
		{ label: "open", value: `type ${index + 1}`, tone: "accent" },
	])}\n`));
	write(theme.dim("Commands  [number] open class · new · refresh · help · quit\n"));
	return classes.map(item => ({ type: "class" as const, item }));
}

async function renderToday(client: SupabaseClient, item: TeacherClass, theme: TerminalTheme, write: (value: string) => void, now: () => Date) {
	const start = startOfDay(now());
	const { data, error } = await client.from("sessions").select("*,profiles!sessions_student_id_fkey(display_name,email),projects(name)").eq("class_id", item.id).gte("started_at", start.toISOString()).order("started_at", { ascending: false });
	if (error) throw error;
	const sessions = (data ?? []) as unknown as Session[];
	const groups = groupSessions(sessions);
	write(`\n${renderPanel(theme, `${item.name} · TODAY`, [
		{ label: "active", value: `${groups.length} students`, tone: "accent" },
		{ label: "sessions", value: String(sessions.length) },
		{ label: "time", value: `${Math.round(groups.reduce((sum, group) => sum + group.seconds, 0) / 60)} minutes` },
		{ label: "tokens", value: sessions.reduce((sum, session) => sum + number(session.total_tokens), 0).toLocaleString() },
		{ label: "attention", value: attentionText(sessions), tone: sessions.some(needsAttention) ? "warning" : "success" },
	])}\n`);
	groups.forEach((group, index) => write(`${renderPanel(theme, `${index + 4} · ${profileName(group.profile, group.studentId)}`, [
		{ label: "sessions", value: `${group.sessions.length} · ${Math.round(group.seconds / 60)}m` },
		{ label: "models", value: [...group.models].join(", ") || "—" },
		{ label: "files", value: `+${group.created} ~${group.modified} -${group.deleted}` },
		{ label: "projects", value: [...group.projects].join(", ") || "—" },
		{ label: "assistance", value: group.high ? `high implementation · ${group.high}` : "mixed", tone: group.high ? "warning" : "muted" },
	])}\n`));
	write(theme.dim("Sections  1/today · 2/students · 3/projects\nCommands  [student number 4+] detail · code · pause/resume · regenerate · back · quit\n"));
	return groups.map(group => ({ type: "student" as const, id: group.studentId, profile: group.profile }));
}

async function renderMembers(client: SupabaseClient, item: TeacherClass, theme: TerminalTheme, write: (value: string) => void) {
	const { data, error } = await client.from("class_members").select("id,user_id,role,status,joined_at,profiles(display_name,email)").eq("class_id", item.id).order("joined_at");
	if (error) throw error;
	const members = (data ?? []) as unknown as Member[];
	write(`\n${renderPanel(theme, `${item.name} · STUDENTS`, [
		{ label: "join code", value: item.join_enabled ? item.join_code : "joining paused", tone: item.join_enabled ? "accent" : "warning" },
		{ label: "pending", value: String(members.filter(member => member.status === "pending").length), tone: members.some(member => member.status === "pending") ? "warning" : "success" },
	])}\n`);
	members.forEach((member, index) => write(`${renderPanel(theme, `${index + 1} · ${profileName(relation(member.profiles), member.user_id)}`, [
		{ label: "role", value: member.role },
		{ label: "status", value: member.status, tone: member.status === "pending" ? "warning" : member.status === "active" ? "success" : "muted" },
		{ label: "joined", value: formatDate(member.joined_at) },
	])}\n`));
	write(theme.dim("Sections  1/today · 2/students · 3/projects\nCommands  approve <number> · reject <number> · pause/resume · regenerate · back · quit\n"));
	return members.map(item => ({ type: "member" as const, item }));
}

async function renderProjects(client: SupabaseClient, item: TeacherClass, theme: TerminalTheme, write: (value: string) => void) {
	const { data, error } = await client.from("projects").select("id,name,description,brief,capability_policy,policy_version,project_requirements(id,title),project_standards(standards(id,code,title))").eq("class_id", item.id).order("created_at");
	if (error) throw error;
	const projects = (data ?? []) as unknown as Project[];
	write(`\n${theme.bold(`${item.name.toUpperCase()} · PROJECTS`)}\n`);
	if (!projects.length) write(`${renderPanel(theme, "No projects yet", [{ label: "next", value: "type new to add a project", tone: "accent" }])}\n`);
	projects.forEach((project, index) => write(`${renderPanel(theme, `${index + 1} · ${project.name}`, [
		{ label: "about", value: project.description || "No description" },
		{ label: "goal", value: normalizeProjectBrief(project.brief).goal || "Not specified" },
		{ label: "structure", value: normalizeProjectBrief(project.brief).structure.join(" · ") || "Not specified" },
		{ label: "requirements", value: project.project_requirements?.map(requirement => requirement.title).join(" · ") || "none" },
		{ label: "standards", value: project.project_standards?.map(link => relation(link.standards)?.code).filter(Boolean).join(", ") || "none", tone: "accent" },
	])}\n`));
	write(theme.dim("Sections  1/today · 2/students · 3/projects\nCommands  new · edit <number> · controls <number> · requirement <number> · standard <number> · back · quit\n"));
	return projects.map(item => ({ type: "project" as const, item }));
}

async function renderStudent(client: SupabaseClient, screen: Extract<Screen, { kind: "student" }>, theme: TerminalTheme, write: (value: string) => void, now: () => Date) {
	let query = client.from("sessions").select("*,projects(name),session_reflections(*),session_requirements(project_requirements(title)),session_standards(standards(code,title))").eq("class_id", screen.item.id).eq("student_id", screen.studentId).order("started_at", { ascending: false });
	if (screen.range !== "project") {
		const start = screen.range === "today" ? startOfDay(now()) : new Date(now().getTime() - 7 * 86_400_000);
		query = query.gte("started_at", start.toISOString());
	}
	const { data, error } = await query;
	if (error) throw error;
	const sessions = (data ?? []) as unknown as Session[];
	write(`\n${renderPanel(theme, `${profileName(screen.profile, screen.studentId)} · ${screen.range.toUpperCase()}`, [
		{ label: "class", value: screen.item.name },
		{ label: "sessions", value: String(sessions.length), tone: "accent" },
		{ label: "scope", value: screen.range === "project" ? "all project history" : screen.range },
	])}\n`);
	if (!sessions.length) write(`${renderPanel(theme, "No sessions in this view", [{ label: "try", value: "choose another time range or refresh" }])}\n`);
	for (const session of sessions) write(`${renderExpandedPanel(theme, session.goal || "Untitled learning session", sessionRows(session))}\n`);
	write(theme.dim("Ranges  1/today · 2/week · 3/project\nCommands  today · week · project · back · quit\n"));
	return [];
}

async function handleInput(client: SupabaseClient, state: { screen: Screen; choices: Array<{ type: string; [key: string]: unknown }> }, command: string, args: string[], readline: Interface, theme: TerminalTheme, write: (value: string) => void) {
	const numbered = Number(command);
	if (state.screen.kind === "classes") {
		if (Number.isInteger(numbered) && numbered > 0) {
			const choice = state.choices[numbered - 1];
			if (choice?.type === "class") state.screen = { kind: "class", item: choice.item as TeacherClass, tab: "today" };
			else throw new Error("That class number is not available.");
			return;
		}
		if (["n", "new", "create"].includes(command)) { await createClass(client, readline); return; }
		throw new Error("Use a class number, new, refresh, help, or quit.");
	}
	if (state.screen.kind === "student") {
		const range = rangeCommand(command);
		if (range) { state.screen = { ...state.screen, range }; return; }
		throw new Error("Use 1/today, 2/week, 3/project, back, refresh, help, or quit.");
	}
	const tab = tabCommand(command);
	if (tab) { state.screen = { ...state.screen, tab }; return; }
	if (state.screen.tab === "today" && Number.isInteger(numbered) && numbered > 0) {
		const choice = state.choices[numbered - 4];
		if (choice?.type !== "student") throw new Error("That student number is not available.");
		state.screen = { kind: "student", item: state.screen.item, studentId: String(choice.id), profile: choice.profile as Profile | null, range: "today" };
		return;
	}
	if (["code", "join"].includes(command)) { write(`\n${theme.accent("Join code")} ${state.screen.item.join_enabled ? state.screen.item.join_code : "joining is paused"}\n`); await pause(readline); return; }
	if (["pause", "resume"].includes(command)) { await toggleJoining(client, state.screen.item, command === "resume"); return; }
	if (["regenerate", "regen"].includes(command)) { await regenerateCode(client, state.screen.item); return; }
	if (state.screen.tab === "students" && ["approve", "reject"].includes(command)) { await updateMembership(client, state.choices, args[0], command === "approve" ? "active" : "rejected"); return; }
	if (state.screen.tab === "projects" && ["n", "new", "create"].includes(command)) { await createProject(client, state.screen.item, readline, write, theme); return; }
	if (state.screen.tab === "projects" && command === "controls") {
		// Managed projects are governed by delegated organization policy; the
		// legacy project column is rejected by the database for these classes.
		if (state.screen.item.organization_id) {
			write(`\n${theme.warning("This class is managed by an organization. Edit delegated project controls in the teacher web dashboard (pi-student teacher web).")}\n`);
			await pause(readline);
			return;
		}
		const project = projectChoice(state.choices, args[0]);
		const policy = await editCapabilities(readline, write, project.capability_policy);
		if (policy) await updateProjectCapabilities(new SupabaseClassroomRepository(client), project.id, policy);
		return;
	}
	if (state.screen.tab === "projects" && ["edit", "update"].includes(command)) { await editProject(client, state.choices, args[0], readline); return; }
	if (state.screen.tab === "projects" && ["requirement", "req"].includes(command)) { await addRequirement(client, state.choices, args[0], readline); return; }
	if (state.screen.tab === "projects" && ["standard", "std"].includes(command)) { await addStandard(client, state.screen.item, state.choices, args[0], readline); return; }
	throw new Error("Unknown command. Type help to see the commands for this view.");
}

async function createClass(client: SupabaseClient, readline: Interface) {
	const name = (await readline.question("Class name › ")).trim();
	if (!name) return;
	const { data: auth, error: authError } = await client.auth.getUser();
	if (authError || !auth.user) throw authError ?? new Error("Sign in first.");
	const { error } = await client.from("classes").insert({ name, teacher_id: auth.user.id });
	if (error) throw error;
}

async function toggleJoining(client: SupabaseClient, item: TeacherClass, enabled: boolean) {
	const { error } = await client.from("classes").update({ join_enabled: enabled }).eq("id", item.id);
	if (error) throw error;
	item.join_enabled = enabled;
}

async function regenerateCode(client: SupabaseClient, item: TeacherClass) {
	const { data, error } = await client.rpc("regenerate_class_join_code", { class_id_input: item.id, expires_at_input: null });
	if (error) throw error;
	const row = Array.isArray(data) ? data[0] : data;
	if (row?.join_code) item.join_code = String(row.join_code);
}

async function updateMembership(client: SupabaseClient, choices: Array<{ type: string; [key: string]: unknown }>, value: string | undefined, status: "active" | "rejected") {
	const choice = choices[Number(value) - 1];
	if (!choice || choice.type !== "member") throw new Error(`Use ${status === "active" ? "approve" : "reject"} <student number>.`);
	const member = choice.item as Member;
	if (member.status !== "pending") throw new Error("Only pending memberships can be approved or rejected.");
	const { error } = await client.from("class_members").update({ status }).eq("id", member.id);
	if (error) throw error;
}

async function createProject(client: SupabaseClient, item: TeacherClass, readline: Interface, write: (value: string) => void, theme: TerminalTheme) {
	write(`\n${theme.bold("CREATE PROJECT")}\n${theme.dim("Enter the learning brief students and their AI will use. Leave optional fields blank; separate list items with semicolons.")}\n`);
	const ask = async (label: string, hint = "") => (await readline.question(`${label}${hint ? ` (${hint})` : ""} › `)).trim();
	const name = await ask("Project name"); if (!name) return;
	const description = await ask("Short overview");
	const subject = await ask("Subject or course");
	const gradeLevel = await ask("Grade or learner level");
	const duration = await ask("Suggested duration");
	const essentialQuestion = await ask("Essential question");
	const goal = await ask("Student-facing goal"); if (!goal) { write(`${theme.warning("A student-facing goal is required; project was not saved.")}\n`); return; }
	const objectives = await ask("Learning objectives", "separate with ;");
	const expectations = await ask("Deliverables and work expectations");
	const structure = await ask("Milestones or expected structure", "separate with ;");
	const constraints = await ask("Scope and constraints", "separate with ;");
	const materials = await ask("Materials and resources", "separate with ;");
	const differentiation = await ask("Access and differentiation", "separate with ;");
	const successCriteria = await ask("Assessment and success criteria", "separate with ;");
	const requirementInput = await ask("Required components", "Title :: details; separate items with ;");
	const standardsInput = await ask("Standards", "CODE | title; separate items with ;");
	const studentFocus = await ask("Student focus reminders", "separate with ;");
	const aiGuidance = await ask("Guidance for the student AI", "help style and concepts to reinforce");
	const list = (value: string) => value.split(";").map(entry => entry.trim()).filter(Boolean);
	const requirements = list(requirementInput).map(entry => { const [title, ...details] = entry.split("::"); return { title: title!.trim(), description: details.join("::").trim() }; }).filter(entry => entry.title);
	const standards = list(standardsInput).map(entry => { const [code, ...title] = entry.split("|"); return { code: code!.trim(), title: title.join("|").trim() }; }).filter(entry => entry.code);
	const draft = { name, description, brief: { version: 1 as const, subject, gradeLevel, duration, essentialQuestion, goal, objectives: list(objectives), expectations, structure: list(structure), constraints: list(constraints), materials: list(materials), differentiation: list(differentiation), successCriteria: list(successCriteria), studentFocus: list(studentFocus), aiGuidance }, requirements, standards };
	write(`${renderProjectDraft(theme, draft)}\n`);
	const choice = (await readline.question("Save this project? [Y/n] › ")).trim().toLowerCase();
	if (choice && choice !== "y" && choice !== "yes") return;
	const saved = await saveProjectDraft(new SupabaseClassroomRepository(client), item.id, draft);
	write(`${theme.success(`Saved ${saved.name}. Students will receive this brief when they select the project.`)}\n`);
}
function renderProjectDraft(theme: TerminalTheme, draft: { name: string; description: string; brief: ProjectBrief; requirements: Array<{ title: string; description: string }>; standards: Array<{ code: string; title: string }> }): string {
	return renderExpandedPanel(theme, draft.name, [
		{ label: "description", value: draft.description || "—" },
		...formatProjectBrief(draft.brief).split("\n").map(line => ({ label: "brief", value: line })),
		{ label: "requirements", value: draft.requirements.map(requirement => requirement.title).join(" · ") || "—" },
		{ label: "standards", value: draft.standards.map(standard => `${standard.code} · ${standard.title}`).join(" · ") || "—", tone: "accent" as const },
	]);
}

async function editProject(client: SupabaseClient, choices: Array<{ type: string; [key: string]: unknown }>, value: string | undefined, readline: Interface) {
	const project = projectChoice(choices, value);
	const current = normalizeProjectBrief(project.brief);
	const name = await keepOrReplace(readline, "Project name", project.name);
	const description = await keepOrReplace(readline, "Description", project.description ?? "");
	const subject = await keepOrReplace(readline, "Subject or course", current.subject);
	const gradeLevel = await keepOrReplace(readline, "Grade or learner level", current.gradeLevel);
	const duration = await keepOrReplace(readline, "Suggested duration", current.duration);
	const essentialQuestion = await keepOrReplace(readline, "Essential question", current.essentialQuestion);
	const goal = await keepOrReplace(readline, "Goal", current.goal);
	const expectations = await keepOrReplace(readline, "Deliverables and work expectations", current.expectations);
	const objectives = await keepOrReplaceList(readline, "Learning objectives", current.objectives);
	const structure = await keepOrReplaceList(readline, "Milestones or expected structure", current.structure);
	const constraints = await keepOrReplaceList(readline, "Constraints", current.constraints);
	const materials = await keepOrReplaceList(readline, "Materials and resources", current.materials);
	const differentiation = await keepOrReplaceList(readline, "Access and differentiation", current.differentiation);
	const successCriteria = await keepOrReplaceList(readline, "Assessment and success criteria", current.successCriteria);
	const studentFocus = await keepOrReplaceList(readline, "Student focus reminders", current.studentFocus);
	const aiGuidance = await keepOrReplace(readline, "Guidance for the student AI", current.aiGuidance);
	await updateProjectBrief(new SupabaseClassroomRepository(client), project.id, { name: name || project.name, description: description || null, brief: { version: 1, subject, gradeLevel, duration, essentialQuestion, goal, objectives, expectations, structure, constraints, materials, differentiation, successCriteria, studentFocus, aiGuidance } });
}

async function keepOrReplace(readline: Interface, label: string, current: string): Promise<string> {
	const answer = (await readline.question(`${label} [${current || "empty"}] › `)).trim();
	return answer || current;
}

async function keepOrReplaceList(readline: Interface, label: string, current: string[]): Promise<string[]> {
	const answer = (await readline.question(`${label} [${current.join("; ") || "empty"}] › `)).trim();
	return answer ? answer.split(/[;\n]/u).map(item => item.trim()).filter(Boolean) : current;
}

function projectChoice(choices: Array<{ type: string; [key: string]: unknown }>, value: string | undefined): Project {
	const choice = choices[Number(value) - 1];
	if (!choice || choice.type !== "project") throw new Error("Choose a project number shown above.");
	return choice.item as Project;
}

async function addRequirement(client: SupabaseClient, choices: Array<{ type: string; [key: string]: unknown }>, value: string | undefined, readline: Interface) {
	const project = projectChoice(choices, value);
	const title = (await readline.question("Requirement › ")).trim();
	if (!title) return;
	const { error } = await client.from("project_requirements").insert({ project_id: project.id, title });
	if (error) throw error;
}

async function addStandard(client: SupabaseClient, item: TeacherClass, choices: Array<{ type: string; [key: string]: unknown }>, value: string | undefined, readline: Interface) {
	const project = projectChoice(choices, value);
	const code = (await readline.question("Standard code › ")).trim();
	if (!code) return;
	const title = (await readline.question("Standard title › ")).trim() || code;
	const { data, error } = await client.from("standards").upsert({ class_id: item.id, code, title }, { onConflict: "class_id,code" }).select("id").single();
	if (error) throw error;
	const { error: linkError } = await client.from("project_standards").upsert({ project_id: project.id, standard_id: data.id }, { onConflict: "project_id,standard_id", ignoreDuplicates: true });
	if (linkError) throw linkError;
}

function groupSessions(sessions: Session[]) {
	const groups = new Map<string, { studentId: string; profile: Profile | null; sessions: Session[]; seconds: number; created: number; modified: number; deleted: number; high: number; models: Set<string>; projects: Set<string> }>();
	for (const session of sessions) {
		const group = groups.get(session.student_id) ?? { studentId: session.student_id, profile: relation(session.profiles), sessions: [], seconds: 0, created: 0, modified: 0, deleted: 0, high: 0, models: new Set(), projects: new Set() };
		group.sessions.push(session); group.seconds += number(session.duration_seconds); group.created += number(session.files_created); group.modified += number(session.files_modified); group.deleted += number(session.files_deleted);
		for (const model of session.models ?? []) group.models.add(model);
		const project = relation(session.projects); if (project?.name) group.projects.add(project.name);
		if (session.implementation_assistance === "high") group.high++;
		groups.set(session.student_id, group);
	}
	return [...groups.values()];
}

function sessionRows(session: Session): PanelRow[] {
	const reflection = session.session_reflections?.[0];
	const requirements = session.session_requirements?.map(item => relation(item.project_requirements)?.title).filter(Boolean).join(", ") || "—";
	const standards = session.session_standards?.map(item => relation(item.standards)?.code).filter(Boolean).join(", ") || "—";
	const rows: PanelRow[] = [
		{ label: "policy", value: session.effective_policy ? JSON.stringify(session.effective_policy) : "Not recorded (older session)" },
		{ label: "compliance", value: session.policy_compliance ? JSON.stringify(session.policy_compliance) : "No runtime summary recorded" },
		{ label: "started", value: formatDateTime(session.started_at) },
		{ label: "project", value: relation(session.projects)?.name ?? "—" },
		{ label: "requirements", value: requirements }, { label: "standards", value: standards, tone: "accent" },
		{ label: "decisions", value: session.decisions?.join(" · ") || "—" }, { label: "blockers", value: session.blockers?.join(" · ") || "—", tone: session.blockers?.length ? "warning" : "muted" },
		{ label: "agent", value: `${session.models?.join(", ") || "—"} · ${session.thinking_mode || "default"} · ${number(session.total_tokens).toLocaleString()} tokens` },
		{ label: "files", value: `+${number(session.files_created)} ~${number(session.files_modified)} -${number(session.files_deleted)}` },
		{ label: "assistance", value: `plan ${session.planning_assistance ?? "none"} · build ${session.implementation_assistance ?? "none"} · debug ${session.debugging_assistance ?? "none"} · explain ${session.explanation_assistance ?? "none"}` },
	];
	if (reflection) rows.push({ label: "accomplished", value: reflection.accomplished || "—", tone: "success" }, { label: "decision", value: reflection.important_decision || "—" }, { label: "unclear", value: reflection.still_unclear || "—", tone: reflection.still_unclear ? "warning" : "muted" }, { label: "next step", value: reflection.next_step || "—" });
	else rows.push({ label: "reflection", value: "No confirmed reflection for this session." });
	return rows;
}

function relation<T>(value: Relation<T> | undefined): T | null { return Array.isArray(value) ? value[0] ?? null : value ?? null; }
function number(value: unknown): number { return typeof value === "number" ? value : Number(value ?? 0) || 0; }
function profileName(profile: Profile | null, fallback: string): string { return profile?.display_name || profile?.email || fallback; }
function needsAttention(session: Session): boolean { return Boolean(session.blockers?.length || session.implementation_assistance === "high"); }
function attentionText(sessions: Session[]): string { const count = sessions.filter(needsAttention).length; return count ? `${count} descriptive signal${count === 1 ? "" : "s"}` : "no signals today"; }
function startOfDay(date: Date): Date { const result = new Date(date); result.setHours(0, 0, 0, 0); return result; }
function formatDate(value: string): string { return new Date(value).toLocaleDateString(); }
function formatDateTime(value: string): string { return new Date(value).toLocaleString(); }
function tabCommand(command: string): "today" | "students" | "projects" | undefined { if (["1", "today", "activity", "t"].includes(command)) return "today"; if (["2", "students", "members", "s"].includes(command)) return "students"; if (["3", "projects", "p"].includes(command)) return "projects"; }
function rangeCommand(command: string): "today" | "week" | "project" | undefined { if (["1", "today", "t"].includes(command)) return "today"; if (["2", "week", "w"].includes(command)) return "week"; if (["3", "project", "p"].includes(command)) return "project"; }
function backScreen(screen: Screen): Screen { if (screen.kind === "student") return { kind: "class", item: screen.item, tab: "today" }; if (screen.kind === "class") return { kind: "classes" }; return screen; }
function breadcrumb(screen: Screen): string { if (screen.kind === "classes") return "My classes"; if (screen.kind === "class") return `${screen.item.name} / ${screen.tab}`; return `${screen.item.name} / ${profileName(screen.profile, screen.studentId)} / ${screen.range}`; }
function clear(write: (value: string) => void, interactive: boolean): void { if (interactive) write("\x1b[2J\x1b[H"); else write("\n"); }
function splitCommand(value: string): string[] { return value.match(/(?:[^\s"]+|"[^"]*")+/gu)?.map(part => part.replace(/^"|"$/g, "")) ?? []; }
async function pause(readline: Interface): Promise<void> { await readline.question("\nPress Enter to continue…"); }
function renderHelp(theme: TerminalTheme): string { return renderPanel(theme, "Teacher dashboard commands", [
	{ label: "numbers", value: "open a card or switch the numbered section", tone: "accent" },
	{ label: "sections", value: "today · students · projects" }, { label: "student", value: "today · week · project" },
	{ label: "classes", value: "new" }, { label: "students", value: "approve <number> · reject <number>" },
	{ label: "projects", value: "new · requirement <number> · standard <number>" },
	{ label: "class code", value: "code · pause · resume · regenerate" },
	{ label: "dictation", value: "/dictate · /dictation setup (terminal only)", tone: "accent" },
	{ label: "global", value: "web · back · refresh · help · quit" },
]); }

function createTeacherDictationSetupUI(
	readline: Interface,
	input: Readable,
	output: Writable,
	theme: TerminalTheme,
	write: (value: string) => void,
): DictationSetupUI {
	return {
		select: async (title, options) => {
			write(`\n${theme.bold(title)}\n`);
			options.forEach((option, index) => write(`  ${theme.accent(String(index + 1))}. ${option}\n`));
			while (true) {
				const answer = (await readline.question("Choose a number › ")).trim();
				const index = Number(answer) - 1;
				if (Number.isInteger(index) && options[index]) return options[index];
				if (!answer) return undefined;
				write(`${theme.warning("Please choose one of the listed options.")}\n`);
			}
		},
		secret: async (title, placeholder) => hiddenQuestion(readline, input, output, `${title}${placeholder ? ` (${placeholder})` : ""} › `),
		notify: (message, type) => {
			const color = type === "error" ? theme.error : type === "warning" ? theme.warning : theme.success;
			write(`${color(message)}\n`);
		},
	};
}

async function hiddenQuestion(readline: Interface, input: Readable, output: Writable, prompt: string): Promise<string | undefined> {
	if (!(input as Readable & { isTTY?: boolean }).isTTY) return readline.question(prompt);
	let echoDisabled = false;
	try {
		output.write(prompt);
		execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
		echoDisabled = true;
		return await readline.question("");
	} finally {
		if (echoDisabled) execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
		output.write("\n");
	}
}

/** Session evidence can be longer than a terminal row, so detail cards wrap it
 * instead of silently clipping student decisions or reflections. */
function renderExpandedPanel(theme: TerminalTheme, title: string, rows: readonly PanelRow[], width = 94): string {
	const innerWidth = Math.max(42, width);
	const safeTitle = truncateText(title, innerWidth - 6);
	const titleSegment = `─ ${safeTitle} `;
	const lines = [`${theme.border("╭")}${theme.accent(titleSegment)}${theme.border(`${"─".repeat(Math.max(0, innerWidth - titleSegment.length))}╮`)}`];
	for (const { label, value, tone = "muted" } of rows) {
		const prefixWidth = 15;
		const valueWidth = innerWidth - prefixWidth - 1;
		const wrapped = wrapText(value, valueWidth);
		wrapped.forEach((part, index) => {
			const prefix = index === 0 ? `  ${label.slice(0, prefixWidth - 2).padEnd(prefixWidth - 2)}` : " ".repeat(prefixWidth);
			const padding = " ".repeat(Math.max(0, valueWidth - Array.from(part).length));
			lines.push(`${theme.border("│")}${theme.dim(prefix)}${theme[tone](part)}${padding} ${theme.border("│")}`);
		});
	}
	lines.push(`${theme.border("╰")}${theme.border(`${"─".repeat(innerWidth)}╯`)}`);
	return lines.join("\n");
}

function wrapText(value: string, width: number): string[] {
	if (!value) return [""];
	const result: string[] = [];
	for (const paragraph of value.split("\n")) {
		let remaining = paragraph.trim();
		while (Array.from(remaining).length > width) {
			const characters = Array.from(remaining);
			const candidate = characters.slice(0, width + 1).join("");
			const breakAt = candidate.lastIndexOf(" ");
			const length = breakAt > Math.floor(width / 2) ? breakAt : width;
			result.push(characters.slice(0, length).join("").trimEnd());
			remaining = characters.slice(length).join("").trimStart();
		}
		result.push(remaining);
	}
	return result.length ? result : [""];
}

function truncateText(value: string, width: number): string { const characters = Array.from(value); return characters.length <= width ? value : `${characters.slice(0, width - 1).join("")}…`; }

export const teacherTuiTestables = {
	splitCommand,
	tabCommand,
	rangeCommand,
	groupSessions,
	sessionRows,
	wrapText,
	renderHelpText: () => renderHelp(createTheme({ isTTY: false, write: () => true } as unknown as Writable)),
};
