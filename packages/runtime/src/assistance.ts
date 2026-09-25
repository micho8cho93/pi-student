import type { CapabilityAvailability, CapabilityRestriction, NextAvailableAction, StudentAction, StudentWorkspaceContext } from "@pi-student/contracts";

const available: Omit<NextAvailableAction, "action"> = { available: true };
const from = (capability: CapabilityAvailability): Omit<NextAvailableAction, "action"> =>
	capability.allowed ? available : { available: false, reason: capability.code ?? "no_model" };
const DEEP_REASONING = new Set(["high", "xhigh", "max"]);

/**
 * Deterministic assistance ladder. Availability comes only from
 * EffectiveStudentCapabilities and workspace state, never from the model.
 * Manual editing, the student's terminal, and tests never depend on AI.
 */
export function resolveNextAvailableActions(workspace: Pick<StudentWorkspaceContext, "capabilities" | "ui">): NextAvailableAction[] {
	const capabilities = workspace.capabilities;
	const { chat } = capabilities;
	const resolved: Record<StudentAction, Omit<NextAvailableAction, "action">> = {
		"agent-edit": from(capabilities.agentFileEditing),
		"agent-run-command": from(capabilities.terminal),
		"agent-install-dependencies": from(capabilities.dependencyInstallation),
		"ask-guidance": from(chat),
		"ask-explanation": from(chat),
		"learn-mode": from(capabilities.learn),
		"deep-reasoning": !chat.allowed ? from(chat)
			: capabilities.reasoningLevels.some(level => DEEP_REASONING.has(level)) ? available : { available: false, reason: "reasoning_restricted" },
		autocomplete: from(capabilities.autocomplete),
		"open-editor": available,
		"use-terminal": available,
		"run-tests": available,
		"view-map": workspace.ui.flowchart?.generatedAt ? available : { available: false, reason: "no_flowchart" },
		"generate-map": from(capabilities.architecture),
		"use-school-tools": from(capabilities.extensions),
		"use-internet": from(capabilities.internet),
	};
	// When a higher rung is lost, point at the next rungs that still work.
	const recommend = new Set<StudentAction>();
	if (!resolved["agent-edit"].available) for (const action of ["ask-guidance", "view-map", "open-editor", "autocomplete", "run-tests"] as const) recommend.add(action);
	if (!chat.allowed) for (const action of ["view-map", "open-editor", "autocomplete", "use-terminal", "run-tests"] as const) recommend.add(action);
	return (Object.keys(resolved) as StudentAction[]).map(action => ({
		action, ...resolved[action], ...(resolved[action].available && recommend.has(action) ? { recommended: true as const } : {}),
	}));
}

export function actionAvailable(actions: readonly NextAvailableAction[], action: StudentAction): boolean {
	return actions.some(item => item.action === action && item.available);
}

/** Student-facing labels. Surfaces may translate these; the model never chooses them. */
export const STUDENT_ACTION_LABELS: Readonly<Record<StudentAction, string>> = {
	"agent-edit": "let the AI edit files",
	"agent-run-command": "let the AI run commands",
	"agent-install-dependencies": "let the AI install packages",
	"ask-guidance": "ask for guidance",
	"ask-explanation": "ask for an explanation",
	"learn-mode": "use Learn mode",
	"deep-reasoning": "use longer AI reasoning",
	autocomplete: "use autocomplete",
	"open-editor": "edit the code yourself",
	"use-terminal": "use the terminal",
	"run-tests": "run tests",
	"view-map": "inspect the architecture in the flowchart",
	"generate-map": "generate the project flowchart",
	"use-school-tools": "use school tools",
	"use-internet": "let the AI use the internet",
};

const HEADLINES: Partial<Record<CapabilityRestriction, string>> = {
	budget_exhausted: "AI help is paused because the AI budget has been reached.",
	agent_budget_exhausted: "The AI implementation budget is used up for now. AI tutoring is still available, so you can keep building it yourself with guidance.",
	provider_unavailable: "The AI model is unavailable right now.",
	no_model: "No AI model is available for this project.",
	project_not_selected: "Select a class project to use AI help.",
	model_cannot_use_tools: "This model can continue helping you reason about the problem, but reliable file editing is unavailable.",
	agent_editing_disabled: "Agent editing is unavailable for this project.",
	sandbox_unavailable: "Agent editing is unavailable because the AI's workspace is not running.",
};

const CAN_STILL: readonly StudentAction[] = ["ask-guidance", "view-map", "generate-map", "open-editor", "autocomplete", "run-tests", "use-terminal"];

/**
 * Turns resolved actions into a short student-facing message: what is lost and
 * what still works. Returns undefined when agent execution is available.
 */
export function describeAssistanceFallback(actions: readonly NextAvailableAction[]): { headline: string; canStill: string[]; hint?: string } | undefined {
	const lost = actions.find(item => item.action === "ask-guidance" && !item.available) ?? actions.find(item => item.action === "agent-edit" && !item.available);
	if (!lost?.reason) return undefined;
	const headline = HEADLINES[lost.reason] ?? (lost.action === "agent-edit" ? "Agent editing is unavailable for now." : "AI help is unavailable for now.");
	const canStill = CAN_STILL.filter(action => actionAvailable(actions, action))
		// A generated map covers "inspect the architecture"; only offer generation when there is none.
		.filter(action => action !== "generate-map" || !actionAvailable(actions, "view-map"))
		.map(action => STUDENT_ACTION_LABELS[action]);
	const hint = lost.reason === "model_cannot_use_tools" ? "Open the relevant file and continue manually." : undefined;
	return { headline, canStill, ...(hint ? { hint } : {}) };
}

export function formatAssistanceFallback(actions: readonly NextAvailableAction[], cause?: string): string | undefined {
	const fallback = describeAssistanceFallback(actions);
	if (!fallback) return cause;
	const detail = cause && cause !== fallback.headline ? ` ${cause}` : "";
	return [`${fallback.headline}${detail}`, ...(fallback.hint ? [fallback.hint] : []), `You can still:\n${fallback.canStill.map(item => `- ${item}`).join("\n")}`].join("\n\n");
}
