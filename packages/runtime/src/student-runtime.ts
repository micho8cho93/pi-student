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
}

/** Composition object: owns provider lifecycles, not learning or infrastructure logic. */
export class PiStudentRuntime {
	private readonly sandboxManager: SandboxManager;
	readonly services: StudentRuntimeServices;
	constructor(readonly options: CreateStudentRuntimeOptions) {
		this.sandboxManager = new SandboxManager(options.projectPath, { provider: options.sandboxProvider });
		this.services = { identityProvider: options.identityProvider, policyProvider: options.policyProvider, telemetrySink: options.telemetrySink, modelAdmission: options.modelAdmission, classroom: options.classroom, contextStore: options.classroom?.contextStore };
	}
	get modelRuntime() { return this.options.modelProvider.runtime; }
	get sandbox(): SandboxRuntime { return this.sandboxManager.runtime; }
	async start(): Promise<void> { await this.sandboxManager.start(); }
	async dispose(): Promise<void> { await this.sandboxManager.stop(); }
	async configuration(model?: ModelDescriptor): Promise<RuntimeConfiguration> {
		const identity = await this.options.identityProvider.getIdentity();
		return { identity, policy: await this.options.policyProvider.resolvePolicy({ identity, projectId: identity.projectId }), model, sandbox: { mode: readSandboxMode() } };
	}
}

export function createStudentRuntime(options: CreateStudentRuntimeOptions): PiStudentRuntime { return new PiStudentRuntime(options); }
