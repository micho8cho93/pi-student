import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { LearningStateUpdate } from "@pi-student/education/types";
import type { WorkflowController } from "@pi-student/education/workflow-controller";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import { prepareLearningStateArguments } from "./tool-arguments.js";
import { Type, type Static } from "typebox";
import { toolResult } from "./tool-result.js";

const LearningStateParams = Type.Object({
	readyForNextStage: Type.Boolean({ description: "Whether the current stage is complete and should advance" }),
	goalSummary: Type.Optional(Type.String({ description: "Concise goal established during UNDERSTAND" })),
	understandingReady: Type.Optional(Type.Boolean({ description: "Whether the requirements and intended outcome are sufficiently understood" })),
	planSummary: Type.Optional(Type.String({ description: "Concise summary of the student-approved implementation plan" })),
	reviewNeedsChanges: Type.Optional(Type.Boolean({ description: "During REVIEW, whether the findings require another implementation pass" })),
	verificationStrategy: Type.Optional(Type.String({ description: "How the implementation will be verified" })),
	verificationPassed: Type.Optional(Type.Boolean({ description: "Whether verification passed" })),
	reflectionComplete: Type.Optional(Type.Boolean({ description: "Whether the student completed reflection" })),
	reason: Type.String({ description: "Why the state update or transition is appropriate" }),
});

export function createLearningStateExtension(workflow: WorkflowController): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "learning_state",
			label: "Learning stage",
			description: "Record progress for the current learning stage. The harness supplies the current stage and chooses the next stage; report only the evidence and stage-specific details.",
			promptSnippet: "Report progress and advance the learning workflow when the current stage is complete.",
			promptGuidelines: [
				"Call learning_state only after the required work in the current stage is complete.",
				"In UNDERSTAND, include goalSummary and understandingReady=true once the goal is clear.",
				"In PLAN, first obtain explicit student approval through student_plan, then include planSummary.",
				"In VERIFY, report verificationPassed explicitly. In REFLECT, report reflectionComplete=true only after the student reflects.",
			],
			parameters: LearningStateParams,
			prepareArguments: (args) => prepareLearningStateArguments(args, workflow.getStage()) as Static<typeof LearningStateParams>,
			executionMode: "sequential",
			async execute(_toolCallId, params) {
				const previousStage = workflow.getStage();
				try {
					const { reviewNeedsChanges, ...reportedProgress } = params;
					const normalizedParams = {
						...reportedProgress,
						currentStage: previousStage,
						...(previousStage === "review" && reviewNeedsChanges ? { requestedNextStage: "implement" as const } : {}),
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
					return toolResult(text, { previousStage, currentStage, completed, state: workflow.getState() });
				} catch (error) {
					return toolResult(
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
