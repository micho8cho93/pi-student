import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { GitHubSignInProgress } from "./github-runtime.js";
import { GhGitHubClient } from "./github-client.js";
import { readEcosystemState } from "./ecosystem-state.js";
import { PublishingService } from "./publishing-service.js";
import type { PublishProgress } from "./types.js";

export const ECOSYSTEM_BRIDGE_PORT = 6769;
const GUI_ORIGIN = "http://127.0.0.1:6767";

export async function runEcosystemBridge(
	port = ECOSYSTEM_BRIDGE_PORT,
	projectPath = process.cwd(),
	paseoHome = process.env.PASEO_HOME,
): Promise<void> {
	let signIn: GitHubSignInProgress | undefined;
	let connecting: Promise<void> | undefined;
	const github = new GhGitHubClient(undefined, progress => { signIn = progress; });
	const activity = new Map<string, { progress?: PublishProgress; publishing: boolean }>();
	const server = createServer(async (request, response) => {
		setSecurityHeaders(response);
		if (!allowRequest(request, response)) return;
		if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
		try {
			const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
			if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, provider: "pi-student-ecosystem", multiProject: true });
			if (request.method === "GET" && url.pathname === "/state") {
				const activeProject = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId") ?? undefined, projectPath);
				const currentActivity = activity.get(activeProject) ?? { publishing: false };
				const state = await readEcosystemState(activeProject, github);
				return json(response, 200, { ...state, ...currentActivity });
			}
			if (request.method === "GET" && url.pathname === "/connect") return json(response, 200, signIn ?? { status: "idle" });
			if (request.method === "POST" && url.pathname === "/connect") {
				if (!connecting) {
					signIn = { status: "preparing" };
					connecting = github.connect().then(() => { signIn = { status: "connected" }; }).catch(error => {
						signIn = { status: "failed", error: safeError(error) };
					}).finally(() => { connecting = undefined; });
				}
				return json(response, 202, signIn);
			}
			if (request.method === "POST" && url.pathname === "/publish") {
				const activeProject = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId") ?? undefined, projectPath);
				const currentActivity = activity.get(activeProject) ?? { publishing: false };
				if (currentActivity.publishing) return json(response, 409, { error: "A deployment is already running." });
				const body = await readBody(request) as { confirmedPublic?: unknown };
				currentActivity.publishing = true;
				currentActivity.progress = { step: "connection", status: "started", message: "Starting publish" };
				activity.set(activeProject, currentActivity);
				void new PublishingService({
					github,
					confirmPublic: async () => body.confirmedPublic === true,
					onProgress: value => { currentActivity.progress = value; },
				}).publish(activeProject).catch(error => {
					currentActivity.progress = { step: "deployment", status: "failed", message: error instanceof Error ? error.message : String(error) };
				}).finally(() => { currentActivity.publishing = false; });
				return json(response, 202, { accepted: true });
			}
			return json(response, 404, { error: "Not found" });
		} catch (error) {
			return json(response, 500, { error: safeError(error) });
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});
	process.stdout.write(`Pi Student ecosystem bridge listening on http://127.0.0.1:${port}\n`);
}

export async function resolvePaseoWorkspacePath(
	paseoHome: string | undefined,
	workspaceId: string | undefined,
	fallbackProject = process.cwd(),
): Promise<string> {
	if (!workspaceId) return path.resolve(fallbackProject);
	if (!/^wks_[A-Za-z0-9_-]+$/.test(workspaceId)) throw new Error("The active Paseo workspace identifier is invalid.");
	if (!paseoHome) throw new Error("Pi Student could not locate Paseo's workspace registry.");
	const registryPath = path.join(paseoHome, "projects", "workspaces.json");
	const registry = JSON.parse(await readFile(registryPath, "utf8")) as Array<{ workspaceId?: unknown; cwd?: unknown; archivedAt?: unknown }>;
	if (!Array.isArray(registry)) throw new Error("Paseo's workspace registry is invalid.");
	const workspace = registry.find(item => item.workspaceId === workspaceId && typeof item.cwd === "string" && !item.archivedAt);
	if (!workspace || typeof workspace.cwd !== "string") throw new Error("Pi Student could not find the active Paseo workspace.");
	return path.resolve(workspace.cwd);
}

function allowRequest(request: IncomingMessage, response: ServerResponse): boolean {
	const origin = request.headers.origin;
	if (origin && origin !== GUI_ORIGIN) { json(response, 403, { error: "Origin not allowed" }); return false; }
	if (request.method === "POST" && request.headers["x-pi-student"] !== "ecosystem") { json(response, 403, { error: "Missing Pi Student request header" }); return false; }
	return true;
}

function setSecurityHeaders(response: ServerResponse): void {
	response.setHeader("Access-Control-Allow-Origin", GUI_ORIGIN);
	response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Pi-Student");
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	let value = "";
	for await (const chunk of request) {
		value += String(chunk);
		if (value.length > 10_000) throw new Error("Request body is too large.");
	}
	return value ? JSON.parse(value) : {};
}

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

function safeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/gh[opsu]_[A-Za-z0-9_]+/g, "[redacted]").slice(0, 1000);
}
