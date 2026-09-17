import type { IdentityProvider, McpProvider, ModelAdmissionProvider, ModelDescriptor, PolicyProvider, RuntimeConfiguration, SkillProvider, TelemetrySink } from "@pi-student/contracts";
import { SandboxManager, readSandboxMode, type SandboxProvider } from "@pi-student/sandbox/sandbox-manager";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import type { ClassroomRuntimeServices } from "./student-classroom.js";
import type { StudentRuntimeServices } from "./telemetry-integration.js";
import type { StudentModelProvider } from "./model-provider.js";

export interface CreateStudentRuntimeOptions {
	projectPath: string;
	modelProvider: StudentModelProvider;
	sandboxProvider: SandboxProvider;
	policyProvider: PolicyProvider;
	telemetrySink?: TelemetrySink;
	modelAdmission?: ModelAdmissionProvider;
	identityProvider: IdentityProvider;
	classroom?: ClassroomRuntimeServices;
	skills?: SkillProvider;
	mcps?: McpProvider;
	environmentProvider?: { resolve(projectId: string, policy?: RuntimeConfiguration["policy"]): Promise<Pick<RuntimeConfiguration, "sandbox" | "skills" | "mcps"> | undefined> };
}

/** Composition object: owns provider lifecycles, not learning or infrastructure logic. */
export class PiStudentRuntime {
	private readonly sandboxManager: SandboxManager;
	private resolved?: Pick<RuntimeConfiguration, "sandbox" | "skills" | "mcps">;
	private selectedProjectId?: string;
	readonly services: StudentRuntimeServices;
	constructor(readonly options: CreateStudentRuntimeOptions) {
		this.sandboxManager = new SandboxManager(options.projectPath, { provider: options.sandboxProvider });
		this.services = { identityProvider: options.identityProvider, policyProvider: options.policyProvider, telemetrySink: options.telemetrySink, modelAdmission: options.modelAdmission, classroom: options.classroom, contextStore: options.classroom?.contextStore, configureEnvironment: (projectId) => this.selectEnvironment(projectId) };
	}
	get modelRuntime() { return this.options.modelProvider.runtime; }
	get sandbox(): SandboxRuntime { return this.sandboxManager.runtime; }
	async start(): Promise<void> {
		const context = await this.options.classroom?.contextStore.read();
		await this.selectEnvironment(context?.projectId);
		await this.sandboxManager.start();
	}
	async dispose(): Promise<void> { await this.sandboxManager.stop(); }
	async configuration(model?: ModelDescriptor): Promise<RuntimeConfiguration> {
		const identity = await this.options.identityProvider.getIdentity();
		const projectId = this.selectedProjectId ?? identity.projectId;
		return { identity, policy: await this.options.policyProvider.resolvePolicy({ identity, projectId }), model,
			sandbox: this.resolved?.sandbox ?? { mode: readSandboxMode() }, skills: this.resolved?.skills, mcps: this.resolved?.mcps };
	}
	async selectEnvironment(projectId?: string): Promise<void> {
		const identity = await this.options.identityProvider.getIdentity();
		const policy = projectId ? await this.options.policyProvider.resolvePolicy({ identity, projectId }) : undefined;
		const resolved = projectId ? await this.options.environmentProvider?.resolve(projectId, policy) : undefined;
		const next = resolved ?? { sandbox: { mode: readSandboxMode() }, skills: [], mcps: [] };
		await this.sandboxManager.configure(next.sandbox);
		this.resolved = next;
		this.selectedProjectId = projectId;
	}
}

export function createStudentRuntime(options: CreateStudentRuntimeOptions): PiStudentRuntime { return new PiStudentRuntime(options); }
