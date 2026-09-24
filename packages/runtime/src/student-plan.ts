import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { formatStudentPlan, hasStudentAuthoredSteps } from "@pi-student/education/student-plan";
import type { WorkflowController } from "@pi-student/education/workflow-controller";
import { StudentPlanParams } from "./tool-parameter-schemas.js";
import { prepareStudentPlanArguments } from "./tool-arguments.js";
import { toolResult as result, ToolExecutionError } from "./tool-result.js";

export function createStudentPlanExtension(workflow: WorkflowController): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "student_plan",
			label: "Student plan",
			description: "Record student-authored implementation steps and obtain explicit student approval for the plan. The student must add at least one step before approval can be requested.",
			promptSnippet: "Maintain the student's implementation plan.",
			promptGuidelines: [
				"Use action=status to inspect the current plan.",
				"Use action=add_step with a concrete step supplied or confirmed by the student; the student confirms each step before it is recorded.",
				"Use action=approve only after status shows at least one student-authored step. Never call approve on an empty plan.",
				"The only valid actions are add_step, approve, and status; do not guess other action names.",
			],
			parameters: StudentPlanParams,
			prepareArguments: prepareStudentPlanArguments,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					if (params.action === "status") {
						return result(formatStudentPlan(workflow.state.plan), { plan: workflow.state.plan, nextAction: workflow.state.plan.approved ? "Continue with learning_state." : "Add student-authored steps, then approve the complete plan." });
					}
					if (params.action === "add_step") {
						const description = params.description?.trim() || await ctx.ui.input("Describe the next implementation step", "e.g. Add project-card rendering");
						if (!description?.trim()) return result("The student did not provide a plan step.", { code: "PLAN_STEP_EMPTY", nextAction: "Ask the student for a concrete implementation step." }, true);
						const confirmed = await ctx.ui.confirm("Add this student-authored plan step?", description);
						if (!confirmed) return result("The student did not add this plan step.", workflow.state.plan);
						workflow.addStudentPlanStep(description);
						return result(formatStudentPlan(workflow.state.plan), workflow.state.plan);
					}

					if (!hasStudentAuthoredSteps(workflow.state.plan)) {
						return result(
							"The plan cannot be approved yet because no student-authored step has been recorded.",
							{
								plan: workflow.state.plan,
								code: "PLAN_REQUIRES_STUDENT_STEP",
								recoverable: true,
								nextAction: "Ask the student to select or type at least one concrete implementation step, then call student_plan with action=add_step.",
							},
							true,
						);
					}

					const approved = await ctx.ui.confirm(
						"Approve implementation plan?",
						formatStudentPlan(workflow.state.plan),
					);
					if (!approved) return result("The student did not approve the plan.", { plan: workflow.state.plan, code: "PLAN_NOT_APPROVED", nextAction: "Revise the plan with the student or continue discussing it; do not call learning_state to advance." });
					workflow.approveStudentPlan("The student reviewed and explicitly approved the implementation plan.");
					return result("The student explicitly approved the implementation plan.", { plan: workflow.state.plan, approved: true, nextAction: "Call learning_state with the plan summary to advance." });
				} catch (error) {
					if (error instanceof ToolExecutionError) throw error;
					return result(error instanceof Error ? error.message : String(error), { plan: workflow.state.plan, code: "STUDENT_PLAN_REJECTED", nextAction: "Call student_plan with action=status, then add or approve the plan as appropriate." }, true);
				}
			},
		});
	};
}
