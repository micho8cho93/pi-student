import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LearningStateUpdate } from "@pi-student/education/types";
import type { WorkflowController } from "@pi-student/education/workflow-controller";
import { capabilityState } from "@pi-student/policy/capability-runtime";

const LearningStageSchema = Type.Union([
	Type.Literal("understand"),
	Type.Literal("plan"),
	Type.Literal("implement"),
	Type.Literal("review"),
	Type.Literal("verify"),
	Type.Literal("reflect"),
]);

const LearningStateParams = Type.Object({
	currentStage: LearningStageSchema,
	readyForNextStage: Type.Boolean({ description: "Whether the current stage is complete and should advance" }),
	goalSummary: Type.Optional(Type.String({ description: "Concise goal established during UNDERSTAND" })),
	understandingReady: Type.Optional(Type.Boolean({ description: "Whether the requirements and intended outcome are sufficiently understood" })),
	planSummary: Type.Optional(Type.String({ description: "Concise summary of the student-approved implementation plan" })),
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
			description: "Record workflow progress and request a controller-validated transition to the next learning stage.",
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
					workflow.updateLearningState(params as LearningStateUpdate);
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
						{ previousStage, currentStage: workflow.getStage(), state: workflow.getState() },
						true,
					);
				}
			},
		});
	};
}
