import { createServer, type Server } from "node:http";
import process from "node:process";
import { dashboardPage } from "./dashboard-page.js";
import { readSupabaseConfig } from "./config.js";
import { openBrowser } from "./open-browser.js";
import { createClient } from "@supabase/supabase-js";
import { createDefaultProjectBuilder, type ProjectBuilderMessage } from "./project-builder.js";

export interface DashboardServerOptions { port?: number; open?: boolean }

export async function startTeacherDashboard(options: DashboardServerOptions = {}): Promise<Server> {
	const config = readSupabaseConfig();
	if (!config) throw new Error("Set PI_STUDENT_SUPABASE_URL and PI_STUDENT_SUPABASE_PUBLISHABLE_KEY before starting the dashboard.");
	let builderPromise: ReturnType<typeof createDefaultProjectBuilder> | undefined;
	const server = createServer((request, response) => {
		const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		if (requestPath === "/api/project-builder" && request.method === "POST") {
			void handleProjectBuilder(request, response, config, () => builderPromise ??= createDefaultProjectBuilder());
			return;
		}
		if (requestPath !== "/" && requestPath !== "/index.html" && requestPath !== "/auth/callback") {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			response.end("Not found");
			return;
		}
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' https://*.supabase.co wss://*.supabase.co; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
		});
		response.end(dashboardPage(config));
	});
	const port = options.port ?? 4173;
	await new Promise<void>((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
	const url = `http://127.0.0.1:${port}`;
	process.stdout.write(`Teacher dashboard: ${url}\nPress Ctrl+C to stop.\n`);
	if (options.open !== false) openBrowser(url);
	return server;
}

async function handleProjectBuilder(
	request: import("node:http").IncomingMessage,
	response: import("node:http").ServerResponse,
	config: { url: string; publishableKey: string },
	getBuilder: () => ReturnType<typeof createDefaultProjectBuilder>,
): Promise<void> {
	try {
		const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
		if (!token) { writeJson(response, 401, { error: "Teacher sign-in is required." }); return; }
		const body = await readJsonBody(request);
		const classId = typeof body.classId === "string" ? body.classId : "";
		const messages = Array.isArray(body.messages) ? body.messages.filter(isBuilderMessage) : [];
		if (!classId || !messages.length || messages.length > 24) { writeJson(response, 400, { error: "A class and project conversation are required." }); return; }
		const authClient = createClient(config.url, config.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
		const { data: auth, error: authError } = await authClient.auth.getUser(token);
		if (authError || !auth.user) { writeJson(response, 401, { error: "Teacher sign-in could not be verified." }); return; }
		const { data: teacherClass, error: classError } = await authClient.from("classes").select("id").eq("id", classId).eq("teacher_id", auth.user.id).maybeSingle();
		if (classError || !teacherClass) { writeJson(response, 403, { error: "You do not teach this class." }); return; }
		const builder = await getBuilder();
		const input = messages[messages.length - 1]!;
		const turn = await builder.turn(messages.slice(0, -1), input.content);
		writeJson(response, 200, turn);
	} catch (error) {
		writeJson(response, 503, { error: error instanceof Error ? error.message : "The project assistant is unavailable." });
	}
}

function isBuilderMessage(value: unknown): value is ProjectBuilderMessage {
	return Boolean(value && typeof value === "object" && (value as { role?: unknown }).role && ["teacher", "assistant"].includes(String((value as { role: unknown }).role)) && typeof (value as { content?: unknown }).content === "string");
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		size += buffer.length;
		if (size > 128_000) throw new Error("The project conversation is too large.");
		chunks.push(buffer);
	}
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function writeJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}
