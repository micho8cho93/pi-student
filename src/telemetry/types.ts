export const ASSISTANCE_LEVELS = ["none", "low", "moderate", "high"] as const;
export type AssistanceLevel = (typeof ASSISTANCE_LEVELS)[number];

export interface StudentReflection {
	accomplished: string;
	importantDecision: string;
	stillUnclear: string;
	nextStep: string;
	confirmedAt: string;
}

export interface LearningRecord {
	policy?: import("../education/capability-policy.js").EffectivePolicy;
	policyCompliance?: { blockedActions: Record<string, number> };
	schemaVersion: 1;
	session: {
		id: string;
		studentId?: string;
		classId?: string;
		projectId?: string;
		startedAt: string;
		endedAt: string;
		durationSeconds: number;
		goal?: string;
	};
	agent: {
		providers: string[];
		models: string[];
		thinkingMode?: string;
		agentTurns: number;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
	activity: {
		filesCreated: number;
		filesModified: number;
		filesDeleted: number;
		testsRun: number;
	};
	learning: {
		requirementIds: string[];
		standardIds: string[];
		decisions: string[];
		blockers: string[];
		questions: string[];
		nextStep: string;
	};
	assistance: {
		planning: AssistanceLevel;
		implementation: AssistanceLevel;
		debugging: AssistanceLevel;
		explanation: AssistanceLevel;
	};
	reflection?: StudentReflection;
}

export interface TeacherContext {
	policy?: import("../education/capability-policy.js").EffectivePolicy;
	classId?: string;
	projectId?: string;
	requirementIds?: string[];
	standardIds?: string[];
}
