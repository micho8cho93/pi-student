import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatStudentPlan } from "@pi-student/education/student-plan";
import type { WorkflowController } from "@pi-student/education/workflow-controller";

const StudentPlanParams = Type.Object({
	action: Type.Union([
		Type.Literal("add_step"),
		Type.Literal("approve"),
		Type.Literal("status"),
	]),
	description: Type.Optional(Type.String({ description: "A student-authored implementation step" })),
});

function result(text: string, details: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

export function createStudentPlanExtension(workflow: WorkflowController): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "student_plan",
			label: "Student plan",
			description: "Record student-authored implementation steps and obtain explicit student approval for the plan.",
			promptSnippet: "Maintain the student's implementation plan.",
			parameters: StudentPlanParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					if (params.action === "status") {
						return result(formatStudentPlan(workflow.state.plan), workflow.state.plan);
					}
					if (params.action === "add_step") {
						const description = params.description?.trim() || await ctx.ui.input("Describe the next implementation step", "e.g. Add project-card rendering");
						if (!description?.trim()) return result("The student did not provide a plan step.", {}, true);
						const confirmed = await ctx.ui.confirm("Add this student-authored plan step?", description);
						if (!confirmed) return result("The student did not add this plan step.", workflow.state.plan);
						workflow.addStudentPlanStep(description);
						return result(formatStudentPlan(workflow.state.plan), workflow.state.plan);
					}

					const approved = await ctx.ui.confirm(
						"Approve implementation plan?",
						formatStudentPlan(workflow.state.plan),
					);
					if (!approved) return result("The student did not approve the plan.", workflow.state.plan);
					workflow.approveStudentPlan("The student reviewed and explicitly approved the implementation plan.");
					return result("The student explicitly approved the implementation plan.", workflow.state.plan);
				} catch (error) {
					return result(error instanceof Error ? error.message : String(error), workflow.state.plan, true);
				}
			},
		});
	};
}
