import { workspaceModelHealthReporter } from "@pi-student/runtime/workspace-model-health";
import { LearnSettingsStore } from "@pi-student/education/settings";
import { resolveLearnScaffolding } from "@pi-student/education/learn-scaffolding";
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
import { FlowchartModelError, generateFlowchart, type Flowchart } from "./flowchart.js";
import { CompletionError, EditorCompletionService, type CompletionRequest, type ModelExecutionEnvironment } from "./editor-completion.js";
import { availableExecutionModels } from "@pi-student/runtime/model-selection";
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
import type { ExecutionContext, ModelAdmissionDecision, ModelAdmissionGate, ModelAdmissionProvider } from "@pi-student/contracts";
import { assertExecutionEnvironment, authorizeExtension } from "@pi-student/runtime/extension-authorization";
import { resolveWorkspaceEventScope, STUDENT_SURFACE_EVENTS, studentEventSurface, TEST_COMMAND, workspaceEventKey, WorkspaceEventJournal, WorkspaceEventStream,
	WorkspaceIdentityRequiredError, type WorkspaceEventScope } from "@pi-student/runtime/workspace-events";
import { createStudentWorkspace, resolveStudentCapabilities, unavailableStudentCapabilities, type StudentCapabilityInputs } from "@pi-student/runtime/student-workspace";
import { buildStudentWorkspaceSnapshot, sessionCapabilitySignals } from "@pi-student/runtime/workspace-snapshot";
import { WorkspaceMapStore } from "@pi-student/runtime/workspace-map-store";
import type { StudentWorkspaceSnapshot, WorkspaceMapStatus } from "@pi-student/contracts";
import { readProjectProgress } from "./project-progress.js";

export const ECOSYSTEM_BRIDGE_PORT = 6769;
const GUI_ORIGIN = "http://127.0.0.1:6767";
const NO_MAP: WorkspaceMapStatus = { available: false, stale: false, staleFiles: [] };

/**
 * A resolved model environment. `admission` is the host's request admission for the
 * project; the bridge turns it into the enforcing gate and derives the budget
 * signals surfaces show from its decisions, so there is no second budget authority.
 */
export interface EcosystemModelExecution extends ModelExecutionEnvironment {
	admission?: Pick<ModelAdmissionProvider, "check">;
}

export interface EcosystemBridgeOptions {
	resolveModelExecution?: (root: string) => Promise<EcosystemModelExecution>;
	/**
	 * The signed-in student, from the trusted authentication layer. Keys workspace activity and maps so
	 * students sharing a machine never see each other's. A managed project without one is unavailable.
	 */
	resolveIdentity?: () => Promise<{ userId?: string }>;
	mapStore?: WorkspaceMapStore;
	/** Origin of the Paseo GUI allowed to call the bridge. Only tests serve the GUI elsewhere. */
	guiOrigin?: string;
}

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

export function createEcosystemBridgeServer(projectPath: string, paseoHome?: string, options: EcosystemBridgeOptions = {}) {
	const guiOrigin = options.guiOrigin ?? GUI_ORIGIN;
	const mapStore = options.mapStore ?? new WorkspaceMapStore();
	let signIn: GitHubSignInProgress | undefined;
	let connecting: Promise<void> | undefined;
	const github = new GhGitHubClient(undefined, progress => { signIn = progress; });
	const activity = new Map<string, { progress?: PublishProgress; publishing: boolean }>();
	const flowchartJobs = new Map<string, Promise<Flowchart>>();
	// Shared with the chat runtime through the local journal; metadata only.
	const eventJournal = new WorkspaceEventJournal();
	const workspaceEvents = new WorkspaceEventStream({ journal: eventJournal });
	const resolveIdentity = options.resolveIdentity ?? defaultIdentity();
	/**
	 * Project scope for the signed-in student, plus the Chat session behind `agentId`
	 * when the GUI names one. The session is resolved from Paseo's agent registry,
	 * never accepted from the browser; an unknown agent yields a session-less view.
	 * Throws WorkspaceIdentityRequiredError for a managed project without a resolved student.
	 */
	const eventScope = async (root: string, workspaceId?: string | null, agentId?: string | null) => {
		const sessionId = workspaceId && agentId ? await resolveLearnSession(paseoHome, root, workspaceId, agentId).catch(() => undefined) : undefined;
		return resolveWorkspaceEventScope(root, await readTeacherContext().catch(() => ({})), { ...await resolveIdentity().catch(() => ({})), ...(sessionId ? { sessionId } : {}) });
	};
	let providerRuntime: ModelRuntime | undefined;
	let codexLogin: { status: string; message?: string; url?: string; code?: string; prompt?: { type: string; message: string; options?: ReadonlyArray<{ id: string; label: string; description?: string }> }; answer?: (value: string) => void; error?: string } | undefined;
	let supabaseLogin: { state: string; userId: string; startedAt: number } | undefined;
	const getProviderRuntime = async () => {
		providerRuntime ??= await createModelRuntime();
		await providerRuntime.refresh({ allowNetwork: false });
		return providerRuntime;
	};
	/**
	 * Latest admission outcome per student project, keyed like workspace state (project and
	 * authenticated student, never a Chat session): institutional limits apply to every
	 * session of that student and never to another student. Presentation only: admission
	 * itself stays the enforcement boundary. Session limits come from each Chat's own events.
	 */
	const admissionSignals = new Map<string, Pick<StudentCapabilityInputs, "exhausted" | "agentExhausted" | "warning">>();
	/** One admission session per student project for GUI-side AI (autocomplete, maps), so students never share one. */
	const completionSessions = new Map<string, string>();
	const admissionKey = (context: ExecutionContext) => workspaceEventKey({ projectPath: context.workspacePath, projectId: context.projectId,
		organizationId: context.organizationId, userId: context.identity.userId });
	const admitted = ({ admission, ...environment }: EcosystemModelExecution): ModelExecutionEnvironment => {
		if (!admission) return environment;
		const { context, beforeRequest: next } = environment;
		const key = admissionKey(context);
		const sessionId = completionSessions.get(key) ?? randomUUID();
		completionSessions.set(key, sessionId);
		const beforeRequest: ModelAdmissionGate = async (provider, modelId, thinking, purpose) => {
			if (context.projectId) {
				const decision = await admission.check(context.projectId, provider, modelId, thinking, sessionId, purpose);
				// Remember the latest decision so workspace actions can show budget lanes without another check.
				admissionSignals.set(key, admissionSignal(decision));
				if (decision.blocked) throw new CompletionError(purpose === "autocomplete" ? "AI completion is paused by the project's model approval or AI budget."
					: "This model is blocked by the project approval or budget.", 403);
			}
			await next?.(provider, modelId, thinking, purpose);
		};
		return { ...environment, beforeRequest };
	};
	const resolveEnvironment = options.resolveModelExecution ?? (async (root: string): Promise<EcosystemModelExecution> => {
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
		return { runtime, context: executionContext, admission };
	});
	const resolveModelExecution = async (root: string) => admitted(await resolveEnvironment(root));
	const completions = new EditorCompletionService(resolveModelExecution);
	/**
	 * The one live StudentWorkspaceSnapshot for a GUI request. Every GUI answer about
	 * capabilities, budget, model, progress, Learn and the map comes from here, so
	 * surfaces cannot disagree. Failing to resolve AI access never hides manual workflows.
	 */
	/** Authorized context and approved, configured models: the expensive (control-plane) inputs of a snapshot. */
	const resolveAccess = (root: string): Promise<{ context: ExecutionContext; models: string[] } | { error: unknown }> => resolveModelExecution(root)
		.then(async ({ runtime, context }) => ({ context, models: (await availableExecutionModels(runtime, context)).map(model => `${model.provider}/${model.id}`) }), error => ({ error }));
	const workspaceSnapshot = async (root: string, scope: WorkspaceEventScope | WorkspaceIdentityRequiredError, request: { workspaceId?: string | null; agentId?: string | null } = {},
		observed: Pick<StudentCapabilityInputs, "model"> = {}, access?: ReturnType<typeof resolveAccess>): Promise<StudentWorkspaceSnapshot> => {
		// A managed project without a resolved student: no journal, map, session or saved progress is read.
		if (scope instanceof WorkspaceIdentityRequiredError) return identityRequiredSnapshot(scope);
		await workspaceEvents.refresh(scope).catch(() => {});
		const ui = workspaceEvents.ui(scope);
		const session = workspaceEvents.session(scope);
		const { sessionId: _session, ...project } = scope;
		const resolved = await (access ?? resolveAccess(root));
		const workspace = await Promise.resolve().then(() => {
			if ("error" in resolved) throw resolved.error;
			// createStudentWorkspace rejects a scope (project or student) that differs from the authorized context.
			return createStudentWorkspace(resolved.context, { claimed: project, ui, capabilities: resolveStudentCapabilities(resolved.context,
				{ ...admissionSignals.get(admissionKey(resolved.context)), ...sessionCapabilitySignals(session), ...observed, models: resolved.models }) });
		}).catch(error => ({ ui, capabilities: unavailableStudentCapabilities(safeError(error), error instanceof CompletionError && error.status === 403 ? "budget_exhausted" : "provider_unavailable") }));
		const [map, savedProgress, learnSetting] = await Promise.all([
			mapStore.status(scope).catch(() => NO_MAP),
			scope.sessionId ? readProjectProgress(paseoHome, root, request.workspaceId ?? null, request.agentId ?? null).catch(() => null) : null,
			scope.sessionId ? new LearnSettingsStore().read(root, scope.sessionId).catch(() => undefined) : undefined,
		]);
		return buildStudentWorkspaceSnapshot({ workspace: { ...workspace, scope: { ...("scope" in workspace ? workspace.scope : { projectPath: scope.projectPath }), sessionId: scope.sessionId } },
			session, savedProgress, learnSetting, map });
	};
	const workspaceActions = async (root: string, scope: WorkspaceEventScope | WorkspaceIdentityRequiredError, request: { workspaceId?: string | null; agentId?: string | null } = {},
		observed: Pick<StudentCapabilityInputs, "model"> = {}) => {
		const snapshot = await workspaceSnapshot(root, scope, request, observed);
		return { actions: snapshot.actions, fallback: snapshot.fallback, budget: snapshot.budget, managed: snapshot.scope.managed,
			...(snapshot.scope.identityRequired ? { workspace: "identity_required" as const } : {}) };
	};
	/** The scope for a snapshot, or the reason a managed workspace is unavailable. */
	const snapshotScope = (root: string, workspaceId?: string | null, agentId?: string | null) => eventScope(root, workspaceId, agentId)
		.catch(error => { if (error instanceof WorkspaceIdentityRequiredError) return error; throw error; });
	const requireApprovedProvider = async (providerId: string) => {
		const approved = await approvedProvidersForCurrentProject();
		if (approved && !approved.includes(providerId)) throw new Error("This model provider is not approved for the selected class project.");
	};
	return createServer(async (request, response) => {
		setSecurityHeaders(response, guiOrigin);
		if (!allowRequest(request, response, guiOrigin)) return;
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
			if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, provider: "pi-student-ecosystem", multiProject: true, learnMode: true, flowchart: true, projectProgress: true });
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
				return json(response, 200, await completions.suggest(root, body, controller.signal, workspaceModelHealthReporter(workspaceEvents,
					await eventScope(root, url.searchParams.get("workspaceId"), url.searchParams.get("agentId")), "editor")));
			}
			if (request.method === "POST" && url.pathname === "/workspace-events") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const root = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId")!, projectPath);
				const body = await readBody(request, 4_000) as Record<string, unknown>;
				const source = studentEventSurface(body);
				if (!source) return json(response, 400, { error: "Workspace event type is not supported." });
				try {
					const scope = await eventScope(root);
					const event = workspaceEvents.emit(scope, source, body, STUDENT_SURFACE_EVENTS);
					// The selected step is restored with the persisted map after a reload.
					if (event.type === "flowchart.node_selected") await mapStore.select(scope, event.id).catch(() => {});
					if (event.type === "flowchart.node_cleared") await mapStore.select(scope, undefined).catch(() => {});
					// Test outcomes are derived here from the student's command; the GUI cannot report them directly.
					if (event.type === "terminal.command_finished" && TEST_COMMAND.test(event.command) && event.exitCode !== undefined) {
						workspaceEvents.emit(scope, "terminal", event.exitCode === 0
							? { type: "test.passed", command: event.command, exitCode: 0 }
							: { type: "test.failed", command: event.command, exitCode: event.exitCode, ...(typeof body.summary === "string" ? { summary: body.summary } : {}) });
					}
				} catch (error) {
					if (error instanceof WorkspaceIdentityRequiredError) throw error;
					return json(response, 400, { error: safeError(error) });
				}
				await eventJournal.flush();
				return json(response, 202, { accepted: true });
			}
			if (request.method === "GET" && url.pathname === "/workspace-activity") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const workspaceId = url.searchParams.get("workspaceId")!;
				const scope = await eventScope(await resolvePaseoWorkspacePath(paseoHome, workspaceId, projectPath), workspaceId, url.searchParams.get("agentId"));
				await workspaceEvents.refresh(scope);
				const latest = workspaceEvents.events(scope).filter(event => event.type === "capability.changed").at(-1);
				const ui = workspaceEvents.ui(scope);
				// One scaffolding profile for every GUI surface, so Code, Map and Terminal agree with Chat.
				return json(response, 200, { ...ui, scaffolding: resolveLearnScaffolding(ui.learn?.enabled === true), capabilityChangedAt: latest?.at });
			}
			if (request.method === "GET" && url.pathname === "/workspace-actions") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const workspaceId = url.searchParams.get("workspaceId")!, agentId = url.searchParams.get("agentId");
				const root = await resolvePaseoWorkspacePath(paseoHome, workspaceId, projectPath);
				const scope = await snapshotScope(root, workspaceId, agentId);
				return json(response, 200, await workspaceActions(root, scope, { workspaceId, agentId }, url.searchParams.get("model") === "unavailable" ? { model: { available: false } } : {}));
			}
			if (request.method === "GET" && url.pathname === "/workspace-snapshot") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const workspaceId = url.searchParams.get("workspaceId")!, agentId = url.searchParams.get("agentId");
				const root = await resolvePaseoWorkspacePath(paseoHome, workspaceId, projectPath);
				const scope = await snapshotScope(root, workspaceId, agentId);
				// ?since=<revision> waits (bounded) until something the surfaces show changes, so the GUI can follow the workspace live.
				const since = url.searchParams.get("since");
				const deadline = Date.now() + Math.min(Math.max(Number(url.searchParams.get("wait") ?? 15_000) || 0, 0), 25_000);
				let closed = false;
				response.once("close", () => { closed = true; });
				// Workspace events and the map are re-read every second; authorization and model inventory every few seconds.
				let access = { at: Date.now(), value: resolveAccess(root) };
				const currentAccess = () => {
					if (Date.now() - access.at >= SNAPSHOT_ACCESS_MS) access = { at: Date.now(), value: resolveAccess(root) };
					return access.value;
				};
				let snapshot = await workspaceSnapshot(root, scope, { workspaceId, agentId }, {}, currentAccess());
				while (since && snapshot.revision === since && Date.now() < deadline && !closed) {
					await new Promise(resolve => setTimeout(resolve, SNAPSHOT_POLL_MS));
					snapshot = await workspaceSnapshot(root, scope, { workspaceId, agentId }, {}, currentAccess());
				}
				if (closed) return;
				return json(response, 200, snapshot);
			}
			if (request.method === "GET" && url.pathname === "/project-progress") {
				if (!url.searchParams.get("workspaceId")) return json(response, 400, { error: "Choose a workspace first." });
				const workspaceId = url.searchParams.get("workspaceId")!, agentId = url.searchParams.get("agentId");
				const root = await resolvePaseoWorkspacePath(paseoHome, workspaceId, projectPath);
				const snapshot = await workspaceSnapshot(root, await snapshotScope(root, workspaceId, agentId), { workspaceId, agentId });
				const { source, ...progress } = snapshot.learning;
				return json(response, 200, { progress: source === "default" ? null : { ...progress, source }, activeFile: snapshot.activity.activeFile,
					actions: snapshot.actions, fallback: snapshot.fallback, budget: snapshot.budget, managed: snapshot.scope.managed });
			}
			if (["GET", "POST"].includes(request.method ?? "") && url.pathname === "/learn-mode") {
				const workspaceId = url.searchParams.get("workspaceId");
				const activeProject = await resolvePaseoWorkspacePath(paseoHome, workspaceId ?? undefined, projectPath);
				const sessionId = await resolveLearnSession(paseoHome, activeProject, workspaceId, url.searchParams.get("agentId"));
				// Learn is session state: a managed project without a resolved student neither shows nor changes it.
				const scope = await eventScope(activeProject).catch(error => { if (error instanceof WorkspaceIdentityRequiredError) throw error; return undefined; });
				const settings = new LearnSettingsStore();
				if (request.method === "POST") {
					const body = await readBody(request) as { learnMode?: unknown };
					if (typeof body.learnMode !== "boolean") return json(response, 400, { error: "learnMode must be a boolean." });
					await settings.write(activeProject, sessionId, body.learnMode);
					// Mirror the toggle into this project's workspace only. Learn is scaffolding, so capabilities are untouched.
					try {
						// Only this conversation's surfaces follow the toggle.
						if (scope) workspaceEvents.emit({ ...scope, sessionId }, "learn", { type: body.learnMode ? "learn.enabled" : "learn.disabled" });
						await eventJournal.flush();
					} catch { /* Activity is best-effort; the setting itself is saved. */ }
				}
				return json(response, 200, { learnMode: await settings.read(activeProject, sessionId) });
			}
			if (request.method === "GET" && url.pathname === "/state") {
				const activeProject = await resolvePaseoWorkspacePath(paseoHome, url.searchParams.get("workspaceId") ?? undefined, projectPath);
				const currentActivity = activity.get(activeProject) ?? { publishing: false };
				const state = await readEcosystemState(activeProject, github);
				return json(response, 200, { ...state, ...currentActivity, environment: await resolvePaseoEnvironmentState(activeProject, resolveModelExecution) });
			}
			if (url.pathname === "/flowchart" && ["GET", "POST"].includes(request.method ?? "")) {
				const workspaceId = url.searchParams.get("workspaceId");
				const projectName = url.searchParams.get("projectName");
				if (!workspaceId && !projectName) return json(response, 400, { error: "Choose a project before generating a flowchart." });
				const activeProject = workspaceId
					? await resolvePaseoWorkspacePath(paseoHome, workspaceId, projectPath)
					: await resolvePaseoProjectPath(paseoHome, projectName!);
				const scope = await eventScope(activeProject, workspaceId, url.searchParams.get("agentId"));
				// Viewing the saved map reads only local files; it never needs AI or a network.
				if (request.method === "GET") {
					const stored = await mapStore.read<Flowchart>(scope).catch(() => undefined);
					return json(response, 200, { chart: stored?.chart ?? null, map: await mapStore.status(scope).catch(() => NO_MAP) });
				}
				const key = workspaceEventKey(scope) + ":" + (scope.sessionId ?? "");
				let job = flowchartJobs.get(key);
				if (!job) {
					job = resolveModelExecution(activeProject).then(({ runtime, context, beforeRequest }) =>
						generateFlowchart(activeProject, runtime, context, beforeRequest, workspaceModelHealthReporter(workspaceEvents, scope, "flowchart"))).then(async ({ sources, ...chart }) => {
						// Saved only after a successful generation, so a failed refresh keeps the last valid map.
						await mapStore.save(scope, chart, sources);
						await workspaceEvents.refresh(scope).catch(() => {});
						workspaceEvents.emit(scope, "flowchart", { type: "flowchart.generated", filesRead: chart.filesRead, ...(chart.model ? { model: chart.model } : {}) });
						await eventJournal.flush();
						return chart;
					});
					flowchartJobs.set(key, job);
					void job.finally(() => { if (flowchartJobs.get(key) === job) flowchartJobs.delete(key); }).catch(() => {});
				}
				try { return json(response, 200, await job); }
				catch (error) {
					// Say what still works (an existing map, editing, terminal) instead of only reporting the failure.
					const health = error instanceof FlowchartModelError ? error.health : undefined;
					const status = error instanceof CompletionError ? error.status : error instanceof FlowchartModelError ? 502 : 500;
					return json(response, status, { error: safeError(error), map: await mapStore.status(scope).catch(() => NO_MAP),
						...await workspaceActions(activeProject, scope, { workspaceId, agentId: url.searchParams.get("agentId") }, !scope.sessionId && health ? { model: { available: false, health } } : {}) });
				}
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
			// Explicit unavailable state for a managed workspace whose student could not be resolved.
			if (error instanceof WorkspaceIdentityRequiredError) return json(response, 403, { error: error.message, workspace: "identity_required" });
			return json(response, error instanceof CompletionError ? error.status : 500, { error: safeError(error) });
		}
	});
}

function admissionSignal(decision: ModelAdmissionDecision): Pick<StudentCapabilityInputs, "exhausted" | "agentExhausted" | "warning"> {
	return decision.blocked ? { exhausted: "The AI budget or model approval blocks this request." }
		: decision.agentBlocked ? { agentExhausted: "The AI implementation budget has been reached." }
			: decision.warning ? { warning: "AI usage is approaching its limit." } : {};
}

/** A managed workspace without a resolved student: only manual work, no workspace, session or map state. */
function identityRequiredSnapshot(error: WorkspaceIdentityRequiredError): StudentWorkspaceSnapshot {
	return buildStudentWorkspaceSnapshot({ workspace: { ui: { openFiles: [], recentChanges: [] }, capabilities: unavailableStudentCapabilities(error.message, "identity_required") },
		session: {}, map: NO_MAP, identityRequired: true });
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

const SNAPSHOT_POLL_MS = 1_000;
const SNAPSHOT_ACCESS_MS = 5_000;

/** Signed-in student from the classroom backend; signed-out or unreachable yields a personal (user-less) scope. Cached briefly. */
function defaultIdentity(): () => Promise<{ userId?: string }> {
	let cached: { at: number; value: Promise<{ userId?: string }> } | undefined;
	return () => {
		if (cached && Date.now() - cached.at < 10_000) return cached.value;
		const config = readSupabaseConfig();
		const value = config
			? new SupabaseIdentityProvider(createPiSupabaseClient(config), "student").getIdentity().then(identity => identity.userId ? { userId: identity.userId } : {}, () => ({}))
			: Promise.resolve({});
		cached = { at: Date.now(), value };
		return value;
	};
}

function allowRequest(request: IncomingMessage, response: ServerResponse, guiOrigin: string): boolean {
	const origin = request.headers.origin;
	if (origin && origin !== guiOrigin) { json(response, 403, { error: "Origin not allowed" }); return false; }
	if (request.method === "POST" && request.headers["x-pi-student"] !== "ecosystem") { json(response, 403, { error: "Missing Pi Student request header" }); return false; }
	return true;
}

function setSecurityHeaders(response: ServerResponse, guiOrigin: string): void {
	response.setHeader("Access-Control-Allow-Origin", guiOrigin);
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
