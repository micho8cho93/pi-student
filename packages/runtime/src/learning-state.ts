import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LearningStateUpdate } from "@pi-student/education/types";
import type { WorkflowController } from "@pi-student/education/workflow-controller";
import { capabilityState } from "@pi-student/policy/capability-runtime";

const LearningStageSchema = Type.Union([
	Type.Literal("understand"),
	Type.Literal("UNDERSTAND"),
	Type.Literal("plan"),
	Type.Literal("PLAN"),
	Type.Literal("implement"),
	Type.Literal("IMPLEMENT"),
	Type.Literal("review"),
	Type.Literal("REVIEW"),
	Type.Literal("verify"),
	Type.Literal("VERIFY"),
	Type.Literal("reflect"),
	Type.Literal("REFLECT"),
]);

const LearningStateParams = Type.Object({
	currentStage: LearningStageSchema,
	readyForNextStage: Type.Boolean({ description: "Whether the current stage is complete and should advance" }),
	goalSummary: Type.Optional(Type.String({ description: "Concise goal established during UNDERSTAND" })),
	understandingReady: Type.Optional(Type.Boolean({ description: "Whether the requirements and intended outcome are sufficiently understood" })),
	planSummary: Type.Optional(Type.String({ description: "Concise summary of the student-approved implementation plan" })),
	studentApprovedPlan: Type.Optional(Type.Boolean({ description: "Must not be true; approval is recorded only by the student_plan interaction" })),
	requestedNextStage: Type.Optional(LearningStageSchema),
	verificationStrategy: Type.Optional(Type.String({ description: "How the implementation will be verified" })),
	verificationPassed: Type.Optional(Type.Boolean({ description: "Whether verification passed" })),
	reflectionComplete: Type.Optional(Type.Boolean({ description: "Whether the student completed reflection" })),
	reason: Type.String({ description: "Why the state update or transition is appropriate" }),
});

function result(text: string, details: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

export function createLearningStateExtension(workflow: WorkflowController): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "learning_state",
			label: "Learning stage",
				description: "Record workflow progress. Stages are lowercase: understand, plan, implement, review, verify, reflect. Uppercase input is normalized safely.",
			promptSnippet: "Report progress and advance the learning workflow when the current stage is complete.",
			promptGuidelines: [
				"Call learning_state whenever a stage becomes ready to advance; do not merely describe the transition in prose.",
				"In UNDERSTAND, include goalSummary and understandingReady=true once the goal is clear.",
				"In PLAN, first record and obtain approval for student-authored steps with student_plan, then include planSummary.",
				"In VERIFY, report verificationPassed explicitly. In REFLECT, report reflectionComplete explicitly.",
			],
			parameters: LearningStateParams,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				const previousStage = workflow.getStage();
				try {
					const normalizedParams = {
						...params,
						currentStage: params.currentStage.toLowerCase() as LearningStateUpdate["currentStage"],
						...(params.requestedNextStage ? { requestedNextStage: params.requestedNextStage.toLowerCase() as LearningStateUpdate["requestedNextStage"] } : {}),
					};
					workflow.updateLearningState(normalizedParams as LearningStateUpdate);
					const currentStage = workflow.getStage();
					const reflectionRequired = capabilityState(workflow).settings.reflection;
					const completed = currentStage === "reflect" && (workflow.state.reflection.complete || !reflectionRequired);
					const text = completed
						? reflectionRequired ? "Learning workflow complete: reflection is recorded." : "Learning workflow complete. Reflection is disabled for this project."
						: currentStage === previousStage
							? `Learning state updated; stage remains ${currentStage.toUpperCase()}.`
							: `Learning stage advanced from ${previousStage.toUpperCase()} to ${currentStage.toUpperCase()}. Continue using the new stage and its active tools.`;
					return result(text, { previousStage, currentStage, completed, state: workflow.getState() });
				} catch (error) {
					return result(
						error instanceof Error ? error.message : String(error),
						{
							previousStage,
							currentStage: workflow.getStage(),
							state: workflow.getState(),
							code: "LEARNING_STATE_REJECTED",
							nextAction: nextActionFor(workflow.getStage()),
						},
						true,
					);
				}
			},
		});
	};
}

function nextActionFor(stage: ReturnType<WorkflowController["getStage"]>): string {
	switch (stage) {
		case "understand": return "Establish a goal and set understandingReady=true before requesting PLAN.";
		case "plan": return "Use student_plan to add or approve student-authored steps, then provide planSummary.";
		case "verify": return "Run verification and report verificationPassed=true or false.";
		case "reflect": return "Complete reflection and report reflectionComplete=true.";
		default: return `Complete the ${stage.toUpperCase()} work before requesting the next stage.`;
	}
}
