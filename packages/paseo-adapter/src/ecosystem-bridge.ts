import { LearnSettingsStore } from "@pi-student/education/settings";
import { resolveLearnSession } from "./paseo-session.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { GitHubSignInProgress } from "@pi-student/publishing/github-runtime";
import { GhGitHubClient } from "@pi-student/publishing/github-client";
import { PublishingMetadataStore } from "@pi-student/publishing/metadata-store";
import { readEcosystemState } from "./ecosystem-state.js";
import { PublishingService } from "@pi-student/publishing/publishing-service";
import type { PublishProgress } from "@pi-student/publishing/types";
import { createModelRuntime } from "@pi-student/runtime/model-runtime";
import { persistApiKey } from "@pi-student/runtime/auth-storage";
import { DEFAULT_OLLAMA_URL, OLLAMA_PROVIDER_ID, readOllamaConfig, registerOllama, saveOllamaUrl } from "@pi-student/runtime/ollama";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { generateFlowchart } from "./flowchart.js";
import { CompletionError, EditorCompletionService, type CompletionRequest } from "./editor-completion.js";
import { providerCatalog } from "@pi-student/shared/provider-catalog";
import { mcpCatalog } from "@pi-student/shared/extension-catalog";
import { approvedProvidersForCurrentProject, currentPiUserId } from "@pi-student/supabase-adapter/provider-approvals";
import { createPiSupabaseClient } from "@pi-student/supabase-adapter/auth";
import { readSupabaseConfig } from "@pi-student/supabase-adapter/config";
import { SupabaseGovernancePolicyProvider } from "@pi-student/supabase-adapter/governance-policy";
import { SupabaseIdentityProvider } from "@pi-student/supabase-adapter/identity-provider";
import { SupabaseModelAdmissionProvider } from "@pi-student/supabase-adapter/model-admission";
import { readTeacherContext } from "@pi-student/telemetry/local-store";
import { DirectModelProvider } from "@pi-student/runtime/model-provider";
import { resolveExecutionContext } from "@pi-student/runtime/execution-context";
import { StoredPolicyProvider } from "@pi-student/policy/provider";
import { beginSupabaseMcpLogin, finishSupabaseMcpLogin, supabaseMcpConnected } from "@pi-student/shared/supabase-mcp-oauth";
import { randomUUID } from "node:crypto";
import { SupabaseExecutionScopeProvider } from "@pi-student/supabase-adapter/execution-scope";
import { SupabaseInstitutionalEnvironmentProvider } from "@pi-student/supabase-adapter/institutional-environment";
import { SandboxManager } from "@pi-student/sandbox/sandbox-manager";
import { GondolinSandboxProvider } from "@pi-student/sandbox-gondolin/provider";
import type { ExecutionContext } from "@pi-student/contracts";
import { assertExecutionEnvironment, authorizeExtension } from "@pi-student/runtime/extension-authorization";
import { resolveWorkspaceEventScope, STUDENT_SURFACE_EVENTS, WorkspaceEventJournal, WorkspaceEventStream } from "@pi-student/runtime/workspace-events";

export const ECOSYSTEM_BRIDGE_PORT = 6769;
const GUI_ORIGIN = "http://127.0.0.1:6767";

export async function runEcosystemBridge(
	port = ECOSYSTEM_BRIDGE_PORT,
	projectPath = process.cwd(),
	paseoHome = process.env.PASEO_HOME,
): Promise<void> {
	const server = createEcosystemBridgeServer(projectPath, paseoHome);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => resolve());
	});
	process.stdout.write(`Pi Student ecosystem bridge listening on http://127.0.0.1:${port}\n`);
}

export function createEcosystemBridgeServer(projectPath: string, paseoHome?: string) {
	let signIn: GitHubSignInProgress | undefined;
	let connecting: Promise<void> | undefined;
	const github = new GhGitHubClient(undefined, progress => { signIn = progress; });
	const activity = new Map<string, { progress?: PublishProgress; publishing: boolean }>();
	const flowchartJobs = new Map<string, Promise<Awaited<ReturnType<typeof generateFlowchart>>>>();
	// Shared with the chat runtime through the local journal; metadata only.
	const eventJournal = new WorkspaceEventJournal();
	const workspaceEvents = new WorkspaceEventStream({ journal: eventJournal });
	const eventScope = async (root: string) => resolveWorkspaceEventScope(root, await readTeacherContext().catch(() => ({})));
	let providerRuntime: ModelRuntime | undefined;
	let codexLogin: { status: string; message?: string; url?: string; code?: string; prompt?: { type: string; message: string; options?: ReadonlyArray<{ id: string; label: string; description?: string }> }; answer?: (value: string) => void; error?: string } | undefined;
	let supabaseLogin: { state: string; userId: string; startedAt: number } | undefined;
	const getProviderRuntime = async () => {
		providerRuntime ??= await createModelRuntime();
		await providerRuntime.refresh({ allowNetwork: false });
		return providerRuntime;
	};
	const completionSessionId = randomUUID();
	const resolveModelExecution = async (root: string) => {
		const runtime = await getProviderRuntime();
		const context = await readTeacherContext();
		const config = readSupabaseConfig();
		if (context.projectId && !config) throw new CompletionError("The selected class project is unavailable. Reconnect before using AI completion.", 403);
		if (!config) return { runtime, context: await resolveExecutionContext({ workspacePath: root, selection: context,
			identityProvider: { getIdentity: async () => ({ kind: "personal" as const }) },
			policyProvider: new StoredPolicyProvider(readTeacherContext) }) };
		const client = createPiSupabaseClient(config);
		const direct = await DirectModelProvider.create(runtime);
		const gatewayUrl = process.env.PI_STUDENT_MODEL_GATEWAY_URL?.trim();
		const governance = new SupabaseGovernancePolicyProvider(client, new StoredPolicyProvider(readTeacherContext), gatewayUrl ? {
			url: gatewayUrl, configure: (projectId, url, profiles, token) => direct.configureHostedProfiles(projectId, url, profiles, token),
		} : undefined, () => runtime.getModels().filter(model => model.provider !== "institution").map(model => ({ provider: model.provider, id: model.id })));
		const resolvedContext = await resolveExecutionContext({ workspacePath: root, selection: context,
			identityProvider: new SupabaseIdentityProvider(client, "student"),
			policyProvider: governance, scopeProvider: new SupabaseExecutionScopeProvider(client),
			environmentProvider: new SupabaseInstitutionalEnvironmentProvider(client) });
		const sandboxManager = new SandboxManager(root, { provider: new GondolinSandboxProvider() });
		const localEnvironment = sandboxManager.inspect(resolvedContext.sandbox);
		const executionContext: ExecutionContext = resolvedContext.environment
			? { ...resolvedContext, environment: { ...resolvedContext.environment, capabilities: localEnvironment.capabilities } }
			: resolvedContext;
		const admission = new SupabaseModelAdmissionProvider(client, (token, sessionId, thinking) => direct.refreshHostedToken(token, sessionId, thinking));
		return { runtime, context: executionContext, beforeRequest: async (provider: string, modelId: string, thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => {
			if (!executionContext.projectId) return;
			const decision = await admission.check(executionContext.projectId, provider, modelId, thinking, completionSessionId);
			if (decision.blocked) throw new CompletionError("This model is blocked by the project approval or budget.", 403);
		} };
	};
	const completions = new EditorCompletionService(resolveModelExecution);
	const requireApprovedProvider = async (providerId: string) => {
		const approved = await approvedProvidersForCurrentProject();
		if (approved && !approved.includes(providerId)) throw new Error("This model provider is not approved for the selected class project.");
	};
	return createServer(async (request, response) => {
		setSecurityHeaders(response);
		if (!allowRequest(request, response)) return;
		if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (request.method === "GET" && url.pathname === "/providers/supabase/callback") {
				const pending = supabaseLogin;
				if (!pending || Date.now() - pending.startedAt > 300000 || url.searchParams.get("state") !== pending.state || !url.searchParams.get("code")) {
					response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Supabase sign-in expired. Start again in Pi Student."); return;
				}
				supabaseLogin = undefined;
				await finishSupabaseMcpLogin(pending.userId, url.searchParams.get("code")!);
				response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" }).end("<h1>Supabase connected</h1><p>You can return to Pi Student.</p>"); return;
			}
			if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, provider: "pi-student-ecosystem", multiProject: true, learnMode: true, flowchart: true });
			if (url.pathname === "/editor-completion/models" && request.method === "GET") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const root = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId")!, projectPath);
				return json(response, 200, { models: await completions.models(root) });
			}
			if (url.pathname === "/editor-completion" && request.method === "POST") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const root = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId")!, projectPath);
				const body = await readBody(request, 80_000) as CompletionRequest;
				const controller = new AbortController();
				response.once("close", () => controller.abort());
				return json(response, 200, await completions.suggest(root, body, controller.signal));
			}
			if (request.method === "POST" && url.pathname === "/workspace-events") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const root = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId")!, projectPath);
				const body = await readBody(request, 4_000);
				try { workspaceEvents.emit(await eventScope(root), "editor", body as Record<string, unknown>, STUDENT_SURFACE_EVENTS); }
				catch (error) { return json(response, 400, { error: safeError(error) }); }
				await eventJournal.flush();
				return json(response, 202, { accepted: true });
			}
			if (request.method === "GET" && url.pathname === "/workspace-activity") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const scope = await eventScope(await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId")!, projectPath));
				await workspaceEvents.refresh(scope);
				const latest = workspaceEvents.events(scope).filter(event => event.type === "capability.changed").at(-1);
				return json(response, 200, { ...workspaceEvents.ui(scope), capabilityChangedAt: latest?.at });
			}
			if (["GET", "POST"].includes(request.method ?? "") && url.pathname === "/learn-mode") {
				const workspaceId = url.searchParams.get("workspaceId");
				const activeProject = await resolvePaseoWorkspacePath(paseoHome, workspaceId ?? undefined, projectPath);
				const sessionId = await resolveLearnSession(paseoHome, activeProject, workspaceId, url.searchParams.get("agentId"));
				const settings = new LearnSettingsStore();
				if (request.method === "POST") {
					const body = await readBody(request) as { learnMode?: unknown };
					if (typeof body.learnMode !== "boolean") return json(response, 400, { error: "learnMode must be a boolean." });
					await settings.write(activeProject, sessionId, body.learnMode);
				}
				return json(response, 200, { learnMode: await settings.read(activeProject, sessionId) });
			}
			if (request.method === "GET" && url.pathname === "/state") {
				const activeProject = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId") ?? undefined, projectPath);
				const currentActivity = activity.get(activeProject) ?? { publishing: false };
				const state = await readEcosystemState(activeProject, github);
				return json(response, 200, { ...state, ...currentActivity, environment: await resolvePaseoEnvironmentState(activeProject, resolveModelExecution) });
			}
			if (request.method === "POST" && url.pathname === "/flowchart") {
				const workspaceId = url.searchParams.get("workspaceId");
				const projectName = url.searchParams.get("projectName");
				if (!workspaceId && !projectName) return json(response, 400, { error: "Choose a project before generating a flowchart." });
				const activeProject = workspaceId
					? await resolvePaseoWorkspacePath(paseoHome, workspaceId, projectPath)
					: await resolvePaseoProjectPath(paseoHome, projectName!);
				let job = flowchartJobs.get(activeProject);
				if (!job) {
					job = resolveModelExecution(activeProject).then(({ runtime, context, beforeRequest }) =>
						generateFlowchart(activeProject, runtime, context, beforeRequest)).then(async chart => {
						const scope = await eventScope(activeProject);
						await workspaceEvents.refresh(scope).catch(() => {});
						workspaceEvents.emit(scope, "flowchart", { type: "flowchart.generated", filesRead: chart.filesRead, ...(chart.model ? { model: chart.model } : {}) });
						return chart;
					});
					flowchartJobs.set(activeProject, job);
					void job.finally(() => { if (flowchartJobs.get(activeProject) === job) flowchartJobs.delete(activeProject); }).catch(() => {});
				}
				return json(response, 200, await job);
			}
			if (request.method === "GET" && url.pathname === "/providers") {
				const runtime = await getProviderRuntime();
				const approved = await approvedProvidersForCurrentProject();
				const ollama = await readOllamaConfig();
				const rows = await Promise.all(providerCatalog
					.filter(provider => (!approved || approved.includes(provider.id)) && (provider.id === OLLAMA_PROVIDER_ID || runtime.getProvider(provider.id)))
					.map(provider => providerRow(runtime, provider.id, provider.name, provider.connection)));
				return json(response, 200, { providers: rows, ollamaUrl: ollama?.url ?? DEFAULT_OLLAMA_URL, codexLogin: codexLogin ? { ...codexLogin, answer: undefined } : undefined });
			}
			if (request.method === "GET" && url.pathname === "/providers/supabase") {
				const activeProject = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId") ?? undefined, projectPath);
				const available = await paseoSupabaseMcpAvailable(activeProject, resolveModelExecution);
				return json(response, 200, { available, connected: available ? await supabaseMcpConnected(await currentPiUserId()) : false });
			}
			if (request.method === "POST" && url.pathname === "/providers/supabase/login") {
				const activeProject = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId") ?? undefined, projectPath);
				if (!await paseoSupabaseMcpAvailable(activeProject, resolveModelExecution)) return json(response, 403, { error: "Your school, teacher, and sandbox have not enabled Supabase MCP for this project." });
				const userId = await currentPiUserId();
				const state = randomUUID();
				supabaseLogin = { state, userId, startedAt: Date.now() };
				const authorizationUrl = await beginSupabaseMcpLogin(userId, state);
				return json(response, 200, { connected: !authorizationUrl, authorizationUrl });
			}
			if (request.method === "POST" && url.pathname === "/providers/openai") {
				await requireApprovedProvider("openai");
				const body = await readBody(request) as { apiKey?: unknown };
				if (typeof body.apiKey !== "string" || !body.apiKey.trim()) return json(response, 400, { error: "Enter an OpenAI API key." });
				await persistApiKey("openai", body.apiKey.trim());
				const runtime = await getProviderRuntime();
				await runtime.refresh({ allowNetwork: false, providers: ["openai"] });
				return json(response, 200, await providerRow(runtime, "openai", "OpenAI", "API key"));
			}
			if (request.method === "POST" && url.pathname === "/providers/key") {
				const body = await readBody(request) as { providerId?: unknown; apiKey?: unknown };
				const item = providerCatalog.find(provider => provider.id === body.providerId && provider.connection === "API key");
				if (!item || typeof body.apiKey !== "string" || !body.apiKey.trim()) return json(response, 400, { error: "Choose a supported provider and enter its API key." });
				await requireApprovedProvider(item.id);
				const runtime = await getProviderRuntime();
				if (!runtime.getProvider(item.id)) return json(response, 400, { error: "This provider is unavailable in the installed model runtime." });
				await persistApiKey(item.id, body.apiKey.trim());
				await runtime.refresh({ allowNetwork: false, providers: [item.id] });
				return json(response, 200, await providerRow(runtime, item.id, item.name, item.connection));
			}
			if (request.method === "POST" && url.pathname === "/providers/ollama") {
				await requireApprovedProvider(OLLAMA_PROVIDER_ID);
				const body = await readBody(request) as { url?: unknown; modelId?: unknown };
				if (typeof body.url !== "string") return json(response, 400, { error: "Enter the Ollama server address." });
				const runtime = await getProviderRuntime();
				const models = await registerOllama(runtime, body.url);
				const modelId = typeof body.modelId === "string" && models.includes(body.modelId) ? body.modelId : models[0];
				await saveOllamaUrl(body.url, modelId);
				return json(response, 200, { ...(await providerRow(runtime, OLLAMA_PROVIDER_ID, "Ollama", "Local server")), models });
			}
			if (request.method === "POST" && url.pathname === "/providers/codex/login") {
				await requireApprovedProvider("openai-codex");
				if (codexLogin?.status === "connecting") return json(response, 409, { error: "Codex sign-in is already in progress." });
				const runtime = await getProviderRuntime();
				if (!runtime.getProvider("openai-codex")?.auth.oauth) return json(response, 400, { error: "Codex sign-in is unavailable in this Pi runtime." });
				codexLogin = { status: "connecting", message: "Starting Codex sign-in…" };
				void runtime.login("openai-codex", "oauth", {
					prompt: async (prompt: { type: string; message: string; options?: ReadonlyArray<{ id: string; label: string; description?: string }> }) => new Promise<string>((resolve, reject) => {
						if (!codexLogin) return reject(new Error("Codex sign-in was cancelled."));
						codexLogin.prompt = prompt;
						codexLogin.answer = resolve;
					}),
					notify: (event: { type: string; message?: string; url?: string; userCode?: string; verificationUri?: string; instructions?: string }) => {
						if (!codexLogin) return;
						codexLogin.message = event.message;
						if (event.type === "auth_url") codexLogin.url = event.url;
						if (event.type === "device_code") { codexLogin.code = event.userCode; codexLogin.url = event.verificationUri; }
					},
				}).then(async () => {
						await runtime.refresh({ allowNetwork: false, providers: ["openai-codex"] });
						codexLogin = { status: "connected", message: "Codex connected." };
					}).catch(error => { codexLogin = { status: "failed", error: safeError(error) }; });
				return json(response, 202, { status: codexLogin.status, message: codexLogin.message });
			}
			if (request.method === "POST" && url.pathname === "/providers/codex/answer") {
				await requireApprovedProvider("openai-codex");
				const body = await readBody(request) as { answer?: unknown };
				if (typeof body.answer !== "string" || !codexLogin?.answer) return json(response, 400, { error: "There is no Codex sign-in prompt to answer." });
				const answer = body.answer.trim();
				const prompt = codexLogin.prompt;
				const value = prompt?.type === "select" && prompt.options
					? prompt.options[Number(answer) - 1]?.id ?? answer
					: answer;
				const resolve = codexLogin.answer;
				delete codexLogin.answer;
				delete codexLogin.prompt;
				resolve(value);
				return json(response, 200, { accepted: true });
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
			if (request.method === "POST" && url.pathname === "/remove-site") {
				const body = await readBody(request) as { projectPath?: unknown };
				if (typeof body.projectPath !== "string") return json(response, 400, { error: "A deployment project is required." });
				const metadata = await new PublishingMetadataStore().list();
				const project = metadata.find(item => item.projectPath === body.projectPath && item.deployment);
				if (!project) return json(response, 404, { error: "Pi Student could not find that deployment." });
				await new PublishingService({ github }).removeSite(project.projectPath);
				return json(response, 200, { removed: true });
			}
			return json(response, 404, { error: "Not found" });
		} catch (error) {
			return json(response, error instanceof CompletionError ? error.status : 500, { error: safeError(error) });
		}
	});
}

async function resolvePaseoEnvironmentState(root: string, resolve: (root: string) => Promise<{ context: Pick<ExecutionContext, "sandbox" | "environment"> }>) {
	const provider = new GondolinSandboxProvider();
	try {
		const resolved = await resolve(root);
		const manager = new SandboxManager(root, { provider });
		const inspected = manager.inspect(resolved.context.sandbox);
		const control = resolved.context.environment;
		if (control && ["pending", "building", "failed", "unsupported"].includes(control.status)) {
			return { ...inspected, status: control.status, requiredCapabilities: control.requiredCapabilities,
				message: control.status === "failed" ? "This coding environment failed to build." : control.status === "pending" || control.status === "building" ? "This coding environment is still being prepared." : inspected.message };
		}
		return inspected;
	} catch {
		const capabilities = provider.capabilities("gondolin");
		return { status: "failed" as const, provider: capabilities.provider, capabilities, requiredCapabilities: ["workspace" as const], message: "Environment state is unavailable. Reconnect and try again." };
	}
}

async function paseoSupabaseMcpAvailable(root: string, resolve: (root: string) => Promise<{ context: ExecutionContext }>): Promise<boolean> {
	try {
		const { context } = await resolve(root);
		return Boolean(context.mcps?.some(item => item.endpoint === "https://mcp.supabase.com/mcp" && authorizeExtension(
			context, item, "mcp", "list", "implement", mcpCatalog.find(catalog => catalog.endpoint === item.endpoint),
		).allowed));
	} catch {
		return false;
	}
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

/** Resolve a project selected on Paseo's new-workspace screen without accepting a browser-supplied path. */
export async function resolvePaseoProjectPath(paseoHome: string | undefined, projectName: string): Promise<string> {
	if (!paseoHome || !projectName || projectName.length > 200) throw new Error("Choose a project before generating a flowchart.");
	const registryPath = path.join(paseoHome, "projects", "projects.json");
	const registry = JSON.parse(await readFile(registryPath, "utf8")) as Array<{ displayName?: unknown; rootPath?: unknown; archivedAt?: unknown }>;
	if (!Array.isArray(registry)) throw new Error("Paseo's project registry is invalid.");
	const matches = registry.filter(item => item.displayName === projectName && typeof item.rootPath === "string" && !item.archivedAt);
	if (matches.length !== 1) throw new Error(matches.length ? "Several projects have this name. Rename one project, then try again." : "Pi Student could not find the selected project.");
	return path.resolve(matches[0].rootPath as string);
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

async function readBody(request: IncomingMessage, limit = 10_000): Promise<unknown> {
	let value = "";
	for await (const chunk of request) {
		value += String(chunk);
		if (value.length > limit) throw new Error("Request body is too large.");
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

async function providerRow(runtime: ModelRuntime, id: string, label: string, method: string) {
	const provider = runtime.getProvider(id);
	const configured = Boolean(provider && runtime.getProviderAuthStatus(id).configured);
	let models: string[] = [];
	if (configured) {
		try { models = (await runtime.getAvailable(id)).map(model => model.id); }
		catch { /* Keep the connection status visible if model discovery is temporarily unavailable. */ }
	}
	return { id, label, method, configured, models };
}
