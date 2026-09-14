export type EngineeringConcernSeverity = "suggestion" | "warning" | "critical";

export type EngineeringConcernCategory =
	| "logic"
	| "architecture"
	| "security"
	| "performance"
	| "maintainability"
	| "testing"
	| "deployment";

export interface EngineeringConcern {
	severity: EngineeringConcernSeverity;
	category: EngineeringConcernCategory;
	description: string;
	consequence: string;
	alternatives?: string[];
	studentDecision?: string;
	acknowledged: boolean;
}
