import path from "node:path";
import type { BudgetLane, CapabilityAvailability, CapabilityRestriction, EffectiveStudentCapabilities, ExecutionContext, LearningStage, StudentWorkspaceContext,
	WorkspaceScope, WorkspaceUiState } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { authorizeExtension, type ExtensionCatalogEntry } from "./extension-authorization.js";
import { resolveWorkspaceBudget, type BudgetSignals } from "./workspace-budget.js";

export interface StudentCapabilityInputs extends BudgetSignals {
	/** Output of availableExecutionModels, as provider/id. Omit when the model runtime is not consulted. */
	models?: readonly string[];
	stage?: LearningStage;
	mcpCatalog?: readonly ExtensionCatalogEntry[];
	/**
	 * Observed state of the active model. available: false when the provider is
	 * unreachable; toolUse: false when the model cannot reliably call tools.
	 * Omitted fields mean "no evidence of a problem".
	 */
	model?: { available?: boolean; toolUse?: boolean };
	/** Whether the agent sandbox is running. Omit when it has not been checked. */
	sandbox?: { running: boolean };
}

const allowed: CapabilityAvailability = { allowed: true };
const deny = (reason: string, code: CapabilityRestriction): CapabilityAvailability => ({ allowed: false, reason, code });

/**
 * Projects ExecutionContext + policy onto student-facing surfaces. Mirrors the
 * enforcement points (capability guard, project-capabilities extension, model
 * selection, extension authorization); it does not define new rules.
 */
export function resolveStudentCapabilities(context: ExecutionContext, inputs: StudentCapabilityInputs = {}): EffectiveStudentCapabilities {
	const settings = context.policy?.settings ?? DEFAULT_CAPABILITY_POLICY;
	const budget = resolveWorkspaceBudget(settings.limits, inputs);
	const models = [...(inputs.models ?? settings.models)];

	// Access to any AI at all, before budget lanes are considered.
	let ai = allowed;
	if (context.classId && !context.projectId) ai = deny("Select a class project before continuing.", "project_not_selected");
	else if (context.organizationId && !settings.models.length) ai = deny("No model is approved for this project.", "no_model");
	else if (inputs.models && !models.length) ai = deny(context.organizationId ? "No institution-approved model is available for this project." : "No configured model is available.", "no_model");
	else if (inputs.model?.available === false) ai = deny("The AI model is unavailable right now.", "provider_unavailable");
	const within = (lane: BudgetLane): CapabilityAvailability => !ai.allowed ? ai
		: lane.status === "exhausted" ? deny(lane.reason ?? "The AI budget has been reached.", "budget_exhausted") : allowed;
	// Chat carries tutoring; it stays open after agent execution closes.
	const chat = within(budget.tutoring);
	const requiresChat = (enabled: boolean, reason: string, code: CapabilityRestriction) => !chat.allowed ? chat : enabled ? allowed : deny(reason, code);

	const toolUse = requiresChat(inputs.model?.toolUse !== false, "This model cannot reliably edit files or run commands.", "model_cannot_use_tools");
	const sandbox = inputs.sandbox?.running === false ? deny("The agent's workspace is not running.", "sandbox_unavailable") : allowed;
	const agentBudget = budget.agent.status === "exhausted" ? deny(budget.agent.reason ?? "The AI implementation budget has been reached.", "agent_budget_exhausted") : allowed;
	// Agent actions need policy permission, agent budget, a tool-capable model, and a running sandbox, in that order.
	const agentAction = (enabled: boolean, reason: string, code: CapabilityRestriction) => {
		const permitted = requiresChat(enabled, reason, code);
		return !permitted.allowed ? permitted : !agentBudget.allowed ? agentBudget : !sandbox.allowed ? sandbox : toolUse;
	};
	const agentFileEditing = agentAction(settings.fileEditing, "File editing is disabled for this project.", "agent_editing_disabled");
	const terminal = agentAction(settings.terminal, "Terminal commands are disabled for this project.", "terminal_disabled");
	const dependencyInstallation = !terminal.allowed ? terminal
		: agentAction(settings.fileEditing && settings.dependencyInstallation, "Dependency installation is disabled for this project.", "dependency_installation_disabled");
	const autocomplete = !within(budget.autocomplete).allowed ? within(budget.autocomplete)
		: settings.fileEditing ? allowed : deny("AI completion is disabled because file editing is disabled for this project.", "autocomplete_disabled");

	const skills = (context.skills ?? []).filter(skill => authorizeExtension(context, skill, "skill", "list", inputs.stage).allowed).map(skill => skill.name);
	const mcps = (context.mcps ?? []).filter(mcp => authorizeExtension(context, mcp, "mcp", "list", inputs.stage,
		inputs.mcpCatalog?.find(item => item.endpoint === mcp.endpoint)).allowed).map(mcp => mcp.name);
	const extensions = !chat.allowed ? chat : skills.length || mcps.length ? allowed : deny("No school tools are available for this project.", "no_extensions");

	return {
		projectId: context.projectId,
		organizationId: context.organizationId,
		chat,
		toolUse,
		sandbox,
		agentFileEditing,
		autocomplete,
		architecture: within(budget.architecture),
		terminal: { ...terminal, inspectionOnly: terminal.allowed && !dependencyInstallation.allowed },
		internet: settings.internet && context.sandbox.internetAllowed !== false ? allowed : deny("Internet access is disabled for this project.", "internet_disabled"),
		dependencyInstallation,
		extensions: { ...extensions, skills, mcps },
		learn: chat,
		models,
		reasoningLevels: [...settings.reasoningLevels],
		budget,
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

/**
 * Capabilities when project controls or the model runtime cannot be resolved at
 * all. Every AI surface is denied; manual editing and the student's own terminal
 * are not capabilities and stay usable.
 */
export function unavailableStudentCapabilities(reason: string, code: CapabilityRestriction = "provider_unavailable"): EffectiveStudentCapabilities {
	const denied = deny(reason, code);
	return {
		chat: denied, toolUse: denied, sandbox: allowed, agentFileEditing: denied, autocomplete: denied, architecture: denied,
		terminal: { ...denied, inspectionOnly: false }, internet: denied, dependencyInstallation: denied,
		extensions: { ...denied, skills: [], mcps: [] }, learn: denied, models: [], reasoningLevels: [],
		budget: resolveWorkspaceBudget(DEFAULT_CAPABILITY_POLICY.limits, code === "budget_exhausted" ? { exhausted: reason } : {}),
	};
}
