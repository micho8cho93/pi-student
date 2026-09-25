import path from "node:path";
import type { CapabilityAvailability, EffectiveStudentCapabilities, ExecutionContext, LearningStage, StudentWorkspaceContext,
	WorkspaceBudgetState, WorkspaceScope, WorkspaceUiState } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { CapabilityState } from "@pi-student/policy/capability-runtime";
import { authorizeExtension, type ExtensionCatalogEntry } from "./extension-authorization.js";

export interface StudentCapabilityInputs {
	/** Output of availableExecutionModels, as provider/id. Omit when the model runtime is not consulted. */
	models?: readonly string[];
	/** Live session usage; limits are read from the policy in the context. */
	usage?: Pick<CapabilityState, "limitReached" | "startedAt" | "turns" | "tokens" | "cost">;
	stage?: LearningStage;
	mcpCatalog?: readonly ExtensionCatalogEntry[];
	now?: number;
}

const allowed: CapabilityAvailability = { allowed: true };
const deny = (reason: string): CapabilityAvailability => ({ allowed: false, reason });

/**
 * Projects ExecutionContext + policy onto student-facing surfaces. Mirrors the
 * enforcement points (capability guard, project-capabilities extension, model
 * selection, extension authorization); it does not define new rules.
 */
export function resolveStudentCapabilities(context: ExecutionContext, inputs: StudentCapabilityInputs = {}): EffectiveStudentCapabilities {
	const settings = context.policy?.settings ?? DEFAULT_CAPABILITY_POLICY;
	const budget = resolveBudget(settings.limits, inputs);
	const models = [...(inputs.models ?? settings.models)];

	let chat = allowed;
	if (context.classId && !context.projectId) chat = deny("Select a class project before continuing.");
	else if (context.organizationId && !settings.models.length) chat = deny("No model is approved for this project.");
	else if (inputs.models && !models.length) chat = deny(context.organizationId ? "No institution-approved model is available for this project." : "No configured model is available.");
	else if (budget.exhausted) chat = deny(budget.exhausted);
	const requiresChat = (enabled: boolean, reason: string) => !chat.allowed ? chat : enabled ? allowed : deny(reason);

	const agentFileEditing = requiresChat(settings.fileEditing, "File editing is disabled for this project.");
	const terminal = requiresChat(settings.terminal, "Terminal commands are disabled for this project.");
	const dependencyInstallation = !terminal.allowed ? terminal
		: requiresChat(settings.fileEditing && settings.dependencyInstallation, "Dependency installation is disabled for this project.");

	const skills = (context.skills ?? []).filter(skill => authorizeExtension(context, skill, "skill", "list", inputs.stage).allowed).map(skill => skill.name);
	const mcps = (context.mcps ?? []).filter(mcp => authorizeExtension(context, mcp, "mcp", "list", inputs.stage,
		inputs.mcpCatalog?.find(item => item.endpoint === mcp.endpoint)).allowed).map(mcp => mcp.name);
	const extensions = !chat.allowed ? chat : skills.length || mcps.length ? allowed : deny("No school tools are available for this project.");

	return {
		projectId: context.projectId,
		organizationId: context.organizationId,
		chat,
		agentFileEditing,
		autocomplete: requiresChat(settings.fileEditing, "AI completion is disabled because file editing is disabled for this project."),
		terminal: { ...terminal, inspectionOnly: terminal.allowed && !dependencyInstallation.allowed },
		internet: settings.internet && context.sandbox.internetAllowed !== false ? allowed : deny("Internet access is disabled for this project."),
		dependencyInstallation,
		extensions: { ...extensions, skills, mcps },
		learn: chat,
		models,
		reasoningLevels: [...settings.reasoningLevels],
		budget,
	};
}

function resolveBudget(limits: WorkspaceBudgetState["limits"], { usage, now = Date.now() }: StudentCapabilityInputs): WorkspaceBudgetState {
	const left = (limit: number | null, used: number) => limit === null ? null : Math.max(0, limit - used);
	return {
		limits: { ...limits },
		remaining: {
			minutes: left(limits.minutes, usage ? (now - usage.startedAt) / 60_000 : 0),
			turns: left(limits.turns, usage?.turns ?? 0),
			tokens: left(limits.tokens, usage?.tokens ?? 0),
			cost: left(limits.cost, usage?.cost ?? 0),
		},
		...(usage?.limitReached() ? { exhausted: usage.limitReached() } : {}),
	};
}

export interface StudentWorkspaceInput {
	capabilities: EffectiveStudentCapabilities;
	learning?: { stage: LearningStage; learnMode: boolean };
	model?: string;
	ui?: Partial<WorkspaceUiState>;
	/** Scope claimed by a restored or remote workspace (e.g. the GUI bridge). Verified, never trusted. */
	claimed?: Partial<WorkspaceScope>;
}

const scopeKeys = ["projectPath", "userId", "projectId", "classId", "organizationId", "sessionId"] as const;

/** Binds workspace state to an already-authorized ExecutionContext. */
export function createStudentWorkspace(context: ExecutionContext, input: StudentWorkspaceInput): StudentWorkspaceContext {
	const scope: WorkspaceScope = Object.freeze({
		projectPath: context.workspacePath, userId: context.identity.userId, projectId: context.projectId,
		classId: context.classId, organizationId: context.organizationId, sessionId: context.sessionId,
	});
	for (const key of scopeKeys) {
		const claimed = input.claimed?.[key];
		if (claimed === undefined) continue;
		const matches = key === "projectPath" ? path.resolve(claimed) === path.resolve(scope.projectPath) : claimed === scope[key];
		if (!matches) throw new Error(`Workspace ${key} does not match the authorized project. Select the project again.`);
	}
	const { capabilities } = input;
	if (capabilities.projectId !== scope.projectId || capabilities.organizationId !== scope.organizationId) {
		throw new Error("Capabilities were resolved for another project.");
	}
	if (input.model && capabilities.models.length && !capabilities.models.includes(input.model)) {
		throw new Error(`Model ${input.model} is not available for this project.`);
	}
	const learning: StudentWorkspaceContext["learning"] = { ...(input.learning ?? { stage: "understand", learnMode: false }) };
	return Object.freeze({
		scope, capabilities, learning,
		...(input.model ? { model: input.model } : {}),
		ui: normalizeUi(scope.projectPath, { openFiles: [], recentChanges: [], ...input.ui }),
	});
}

/** Applies a transient UI patch. Identity, capabilities, and learning cannot be changed here. */
export function updateWorkspaceUi(workspace: StudentWorkspaceContext, patch: Partial<WorkspaceUiState>): StudentWorkspaceContext {
	const forbidden = Object.keys(patch).filter(key => !uiKeys.has(key));
	if (forbidden.length) throw new Error(`Workspace UI updates cannot change ${forbidden.join(", ")}.`);
	return Object.freeze({ ...workspace, ui: normalizeUi(workspace.scope.projectPath, { ...workspace.ui, ...patch }) });
}

const uiKeys = new Set<string>(["activeFile", "openFiles", "selectedCode", "recentChanges", "terminal", "tests", "flowchart"]);

function normalizeUi(projectPath: string, ui: WorkspaceUiState): WorkspaceUiState {
	const file = (value: string) => {
		const relative = path.relative(projectPath, path.resolve(projectPath, value));
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${value} is outside the project workspace.`);
		return relative.split(path.sep).join("/");
	};
	return Object.freeze({
		...ui,
		...(ui.activeFile ? { activeFile: file(ui.activeFile) } : {}),
		openFiles: [...new Set(ui.openFiles.map(file))],
		...(ui.selectedCode ? { selectedCode: { ...ui.selectedCode, file: file(ui.selectedCode.file) } } : {}),
		recentChanges: ui.recentChanges.map(change => ({ ...change, file: file(change.file) })),
	});
}
