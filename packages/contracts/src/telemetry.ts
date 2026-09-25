import type { ClassId, OrganizationId, ProjectId, RequirementId, SessionId, StandardId, UserId } from "./identity.js";
import type { EffectivePolicy } from "./policy.js";

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
	policy?: EffectivePolicy;
	policyCompliance?: { blockedActions: Record<string, number> };
	schemaVersion: 1;
	session: {
		id: SessionId;
		studentId?: UserId;
		organizationId?: OrganizationId;
		classId?: ClassId;
		projectId?: ProjectId;
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
	activity: { filesCreated: number; filesModified: number; filesDeleted: number; testsRun: number };
	learning: {
		requirementIds: RequirementId[];
		standardIds: StandardId[];
		decisions: string[];
		blockers: string[];
		questions: string[];
		nextStep: string;
	};
	assistance: Record<"planning" | "implementation" | "debugging" | "explanation", AssistanceLevel>;
	reflection?: StudentReflection;
}

export interface TeacherContext {
	policy?: EffectivePolicy;
	classId?: ClassId;
	organizationId?: OrganizationId;
	projectId?: ProjectId;
	requirementIds?: RequirementId[];
	standardIds?: StandardId[];
}

export interface UsageEvent {
	type: "usage";
	eventId: string;
	sessionId: SessionId;
	organizationId?: OrganizationId;
	classId?: ClassId;
	userId?: UserId;
	projectId?: ProjectId;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	provider: string;
	model: string;
	recordedAt: string;
}

export interface LearningTelemetryEvent {
	type: "learning";
	sessionId: SessionId;
	name: string;
	recordedAt: string;
	attributes?: Readonly<Record<string, string | number | boolean>>;
}

export interface LearningRecordEvent {
	type: "learning-record";
	record: LearningRecord;
}

export interface SafetySignalEvent { type: "safety-signal"; classId: string; categories: string[]; }
export type TelemetryEvent = UsageEvent | LearningTelemetryEvent | LearningRecordEvent | SafetySignalEvent;

/** Destination-neutral telemetry boundary. Implementations may persist locally or remotely. */
export interface TelemetrySink {
	record(event: TelemetryEvent): Promise<void>;
}
