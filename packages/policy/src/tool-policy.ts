import type { LearningStage } from "@pi-student/contracts";

// Pi exposes pwd through the safe Bash inspection policy rather than as a
// separate built-in tool in the current SDK.
export const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
export const EDUCATION_TOOLS = ["student_ask", "learning_state"] as const;
export const SAFE_INSPECTION_TOOLS = ["bash"] as const;
export const IMPLEMENTATION_TOOLS = ["bash", "read", "grep", "find", "ls", "edit", "write"] as const;

const TOOLS_BY_STAGE: Record<LearningStage, readonly string[]> = {
	understand: [...READ_TOOLS, ...SAFE_INSPECTION_TOOLS, ...EDUCATION_TOOLS],
	plan: [...READ_TOOLS, ...SAFE_INSPECTION_TOOLS, ...EDUCATION_TOOLS, "student_plan"],
	implement: [...IMPLEMENTATION_TOOLS, ...EDUCATION_TOOLS, "student_plan"],
	review: [...READ_TOOLS, ...SAFE_INSPECTION_TOOLS, ...EDUCATION_TOOLS],
	verify: ["read", "grep", "find", "ls", "bash", "edit", "write", ...EDUCATION_TOOLS],
	reflect: [...READ_TOOLS, ...SAFE_INSPECTION_TOOLS, ...EDUCATION_TOOLS, "save_to_desktop"],
};

const REGISTERED_TOOLS = [...new Set(Object.values(TOOLS_BY_STAGE).flat())];

export interface ToolPolicy {
	registeredTools(): readonly string[];
	allowedTools(stage: LearningStage): readonly string[];
	canUseTool(stage: LearningStage, toolName: string): boolean;
}

export const toolPolicy: ToolPolicy = {
	registeredTools() {
		return REGISTERED_TOOLS;
	},
	allowedTools(stage) {
		return TOOLS_BY_STAGE[stage];
	},
	canUseTool(stage, toolName) {
		return TOOLS_BY_STAGE[stage].includes(toolName);
	},
};
