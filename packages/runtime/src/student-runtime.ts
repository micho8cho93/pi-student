import type { ExecutionContext, ExecutionScopeProvider, IdentityProvider, McpProvider, ModelAdmissionProvider, ModelDescriptor, PolicyProvider, RuntimeConfiguration, SandboxEnvironmentState, SkillProvider, TelemetrySink } from "@pi-student/contracts";
import { SandboxManager, type SandboxProvider } from "@pi-student/sandbox/sandbox-manager";
import { SandboxConfigurationError, type SandboxRuntime } from "@pi-student/sandbox/types";
import type { ClassroomRuntimeServices } from "./student-classroom.js";
import type { StudentRuntimeServices } from "./telemetry-integration.js";
import type { StudentModelProvider } from "./model-provider.js";
import type { TeacherContext } from "@pi-student/telemetry/types";
import type { TeacherContextStore } from "@pi-student/telemetry/local-store";
import { resolveExecutionContext } from "./execution-context.js";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";

export interface CreateStudentRuntimeOptions {
	projectPath: string;
	modelProvider: StudentModelProvider;
	sandboxProvider: SandboxProvider;
	policyProvider: PolicyProvider;
	telemetrySink?: TelemetrySink;
	modelAdmission?: ModelAdmissionProvider;
	identityProvider: IdentityProvider;
	contextStore?: TeacherContextStore;
	scopeProvider?: ExecutionScopeProvider;
	classroom?: ClassroomRuntimeServices;
	skills?: SkillProvider;
	mcps?: McpProvider;
	environmentProvider?: { resolve(projectId: string, policy?: RuntimeConfiguration["policy"]): Promise<Pick<RuntimeConfiguration, "sandbox" | "skills" | "mcps" | "environment"> & { status?: SandboxEnvironmentState["status"]; requiredCapabilities?: SandboxEnvironmentState["requiredCapabilities"] } | undefined> };
}

/** Composition object: owns provider lifecycles, not learning or infrastructure logic. */
export class PiStudentRuntime {
	private readonly sandboxManager: SandboxManager;
	private sessionId?: string;
	readonly services: StudentRuntimeServices;
	constructor(readonly options: CreateStudentRuntimeOptions) {
		this.sandboxManager = new SandboxManager(options.projectPath, { provider: options.sandboxProvider });
		this.services = {
			extensionEnvironment: async () => {
				const context = await this.executionContext();
				return { sandbox: context.sandbox, skills: context.skills, mcps: context.mcps };
			},
			executionContext: () => this.executionContext(),
			bindSession: session => this.bindSession(session),
			preferredFallbackModelId: (provider, modelId) => options.modelProvider.fallbackFor?.(provider, modelId),
			identityProvider: options.identityProvider,
			policyProvider: options.policyProvider,
			telemetrySink: options.telemetrySink,
			modelAdmission: options.modelAdmission,
			classroom: options.classroom ? { ...options.classroom, workspacePath: options.projectPath } : undefined,
			contextStore: options.contextStore ?? options.classroom?.contextStore,
			configureEnvironment: selection => this.selectEnvironment(selection),
			reconcileEnvironment: context => this.applyEnvironment(context),
		};
	}
	get modelRuntime() { return this.options.modelProvider.runtime; }
	get sandbox(): SandboxRuntime { return this.sandboxManager.runtime; }
	async start(): Promise<void> {
		await this.selectEnvironment();
		await this.sandboxManager.start();
	}
	async dispose(): Promise<void> { await this.sandboxManager.stop(); }
	async configuration(model?: ModelDescriptor): Promise<ExecutionContext> {
		const context = await this.executionContext();
		return { ...context, model };
	}
	async executionContext(selection?: TeacherContext): Promise<ExecutionContext> {
		const context = await resolveExecutionContext({ workspacePath: this.options.projectPath,
			sessionId: this.sessionId,
			selection: selection ?? await (this.options.contextStore ?? this.options.classroom?.contextStore)?.read() ?? {},
			identityProvider: this.options.identityProvider, policyProvider: this.options.policyProvider,
			scopeProvider: this.options.scopeProvider, environmentProvider: this.options.environmentProvider });
		const managerState = this.sandboxManager.getEnvironmentState();
		if (!context.environment && managerState.status === "configured") return context;
		const environment = {
			...(context.environment ?? managerState),
			capabilities: this.sandboxManager.getCapabilities(),
			// A running VM never masks a control-plane state that forbids execution.
			status: this.sandboxManager.isRunning() && (!context.environment || ["configured", "ready", "active"].includes(context.environment.status))
				? "active" as const : (context.environment?.status ?? managerState.status),
		};
		return { ...context, environment };
	}
	async bindSession(session: Pick<SessionManager, "getCwd" | "getSessionId">): Promise<void> {
		const expected = await realpath(this.options.projectPath);
		const actual = await realpath(session.getCwd()).catch(() => undefined);
		if (actual !== expected) throw new Error("Saved session belongs to another workspace.");
		this.sessionId = session.getSessionId();
	}
	async selectEnvironment(selection?: TeacherContext): Promise<void> {
		await this.applyEnvironment(await this.executionContext(selection));
	}
	/** Idempotent: the manager only restarts the sandbox when the resolved configuration changed. */
	async applyEnvironment(next: ExecutionContext): Promise<void> {
		if (next.environment) {
			const capabilities = this.sandboxManager.getCapabilities();
			const state = { ...next.environment, capabilities };
			this.sandboxManager.setEnvironmentState(state);
			if (["pending", "building", "failed", "unsupported"].includes(state.status)) {
				const message = state.status === "failed"
					? "This coding environment failed to build. Ask an administrator to rebuild it."
					: state.status === "pending" || state.status === "building"
						? "This coding environment is still being prepared. Try again after it is ready."
						: "This coding environment is not supported by the current runtime.";
				throw new SandboxConfigurationError(message, next.sandbox.mode, state.status, state.requiredCapabilities);
			}
		}
		await this.sandboxManager.configure(next.sandbox);
	}
}

export function createStudentRuntime(options: CreateStudentRuntimeOptions): PiStudentRuntime { return new PiStudentRuntime(options); }
