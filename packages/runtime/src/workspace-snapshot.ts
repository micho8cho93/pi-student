import { createHash } from "node:crypto";
import type { CapabilityRestriction, StudentWorkspaceContext, StudentWorkspaceSnapshot, WorkspaceLearningProgress, WorkspaceMapStatus,
	WorkspaceSessionState, WorkspaceUiState } from "@pi-student/contracts";
import type { LearningSession } from "@pi-student/education/types";
import { resolveLearnScaffolding } from "@pi-student/education/learn-scaffolding";
import { isSensitiveContextPath } from "@pi-student/shared/file-context";
import { redactSensitiveText } from "@pi-student/telemetry/privacy";
import { describeAssistanceFallback, resolveNextAvailableActions } from "./assistance.js";
import type { StudentCapabilityInputs } from "./student-workspace.js";
import { describeWorkspaceBudget } from "./workspace-budget.js";

const summary = (value: string | undefined) => value ? redactSensitiveText(value.replace(/\s+/g, " ").trim()).slice(0, 160) || undefined : undefined;

/** The bounded, shareable part of a WorkflowController state. */
export function learningProgress(state: Pick<LearningSession, "stage" | "goal" | "understanding" | "plan" | "verification">): WorkspaceLearningProgress {
	const step = state.plan?.steps?.find(item => item.status === "active") ?? state.plan?.steps?.find(item => item.status === "pending");
	const goal = summary(state.goal), activeStep = summary(step?.description);
	return { stage: state.stage, ...(goal ? { goal } : {}), ...(activeStep ? { activeStep } : {}), understandingReady: state.understanding?.ready === true,
		planApproved: state.plan?.approved === true, verificationPassed: state.verification?.passed === true };
}

/**
 * What a Chat session published about its budget and model, as capability inputs.
 * These only ever narrow what surfaces offer; enforcement stays with admission and
 * the session's tool guards.
 */
export function sessionCapabilitySignals(session: WorkspaceSessionState): Pick<StudentCapabilityInputs, "exhausted" | "agentExhausted" | "warning" | "model"> {
	const exhausted = session.budget?.exhausted;
	return {
		...(exhausted?.lane === "all" ? { exhausted: exhausted.reason } : exhausted?.lane === "agent" ? { agentExhausted: exhausted.reason } : {}),
		...(session.budget?.warning ? { warning: session.budget.warning.reason } : {}),
		...(session.model && (session.model.available !== undefined || session.model.toolUse !== undefined)
			? { model: { ...(session.model.available === undefined ? {} : { available: session.model.available }), ...(session.model.toolUse === undefined ? {} : { toolUse: session.model.toolUse }) } } : {}),
	};
}

export interface StudentWorkspaceSnapshotInput {
	/** Scope-checked workspace, or only capabilities and UI when the project could not be authorized. */
	workspace: Pick<StudentWorkspaceContext, "capabilities" | "ui"> & Partial<Pick<StudentWorkspaceContext, "scope">>;
	/** State the bound Chat session published; empty when no session is bound. */
	session: WorkspaceSessionState;
	/** The session's last persisted WorkflowController snapshot, used when it has published nothing live. */
	savedProgress?: WorkspaceLearningProgress | null;
	/** The session's durable Learn setting, used until Chat reports the setting it actually used. */
	learnSetting?: boolean;
	map: WorkspaceMapStatus;
}

const MODEL_CODES = new Set<CapabilityRestriction>(["no_model", "provider_unavailable", "project_not_selected"]);

/**
 * Derives the current StudentWorkspaceSnapshot. Nothing here is stored: every
 * field is computed from its authority on each call, so surfaces that render the
 * snapshot cannot disagree with each other or drift from enforcement inputs.
 */
export function buildStudentWorkspaceSnapshot(input: StudentWorkspaceSnapshotInput): StudentWorkspaceSnapshot {
	const { workspace, session, map } = input;
	const { capabilities } = workspace;
	// The persisted map is the authority for whether a map exists and is current.
	const ui: WorkspaceUiState = { ...workspace.ui, flowchart: map.available
		? { generatedAt: map.generatedAt, stale: map.stale, staleFiles: map.staleFiles, ...(workspace.ui.flowchart?.selectedNode ?? map.selectedNode
			? { selectedNode: workspace.ui.flowchart?.selectedNode ?? map.selectedNode } : {}) }
		: workspace.ui.flowchart?.selectedNode ? { stale: false, selectedNode: workspace.ui.flowchart.selectedNode } : undefined };
	const actions = resolveNextAvailableActions({ capabilities, ui });
	const fallback = describeAssistanceFallback(actions);
	const live = session.progress;
	const learning = live
		? { stage: live.stage, ...(live.goal ? { goal: live.goal } : {}), ...(live.activeStep ? { activeStep: live.activeStep } : {}), understandingReady: live.understandingReady,
			planApproved: live.planApproved, verificationPassed: live.verificationPassed, source: "live" as const }
		: input.savedProgress ? { ...input.savedProgress, source: "saved" as const }
			: { stage: "understand" as const, understandingReady: false, planApproved: false, verificationPassed: false, source: "default" as const };
	const learnEnabled = session.learn?.enabled ?? input.learnSetting ?? false;
	const modelCode = !capabilities.chat.allowed && capabilities.chat.code && MODEL_CODES.has(capabilities.chat.code) ? capabilities.chat.code : undefined;
	const safe = (file: string) => !isSensitiveContextPath(file);
	const selectedNode = ui.flowchart?.selectedNode;
	const lastRun = workspace.ui.tests?.lastRun;
	const body: Omit<StudentWorkspaceSnapshot, "revision"> = {
		scope: { managed: Boolean(capabilities.projectId), ...(workspace.scope?.projectId ? { projectId: workspace.scope.projectId } : {}),
			...(workspace.scope?.classId ? { classId: workspace.scope.classId } : {}), ...(workspace.scope?.organizationId ? { organizationId: workspace.scope.organizationId } : {}),
			session: Boolean(workspace.scope?.sessionId) },
		learning,
		learn: resolveLearnScaffolding(learnEnabled),
		capabilities,
		budget: describeWorkspaceBudget(capabilities.budget),
		model: { available: !modelCode, ...(modelCode ? { reason: modelCode } : {}), ...(session.model?.selected ? { selected: session.model.selected } : {}) },
		actions,
		...(fallback ? { fallback } : {}),
		map: { ...map, staleFiles: map.staleFiles.filter(safe), ...(selectedNode && (!selectedNode.file || safe(selectedNode.file)) ? { selectedNode } : { selectedNode: undefined }) },
		activity: {
			...(workspace.ui.activeFile && safe(workspace.ui.activeFile) ? { activeFile: workspace.ui.activeFile } : {}),
			recentChanges: workspace.ui.recentChanges.filter(change => safe(change.file)).slice(-8),
			...(lastRun ? { lastTest: (({ summary: _summary, ...rest }) => rest)(lastRun) } : {}),
		},
	};
	if (!body.map.selectedNode) delete body.map.selectedNode;
	const revision = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 20);
	return { revision, ...body };
}
