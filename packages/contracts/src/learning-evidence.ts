/** A rebuildable, metadata-only interpretation of existing workspace and session records. */
export type LearningEvidenceCategory =
	| "plan_approved" | "student_edit" | "agent_edit" | "autocomplete_edit" | "student_revised_agent_work"
	| "test_failed" | "fix_attempted" | "test_passed" | "fix_verified"
	| "learn_mode_used" | "question_completed" | "reflection_completed";

export type LearningEvidenceActor = "student" | "agent" | "mixed";
export type LearningEvidenceSource = "observed" | "deterministic" | "classified";

export interface LearningEvidenceEvent {
	/** Stable hash of category and referenced source IDs. */
	id: string;
	timestamp: string;
	projectId: string;
	/** Session association is supplied by the recording window; project events have no native session. */
	sessionId?: string;
	category: LearningEvidenceCategory;
	actor: LearningEvidenceActor;
	source: LearningEvidenceSource;
	/** Present only for a classified event; this pipeline currently emits none. */
	confidence?: number;
	summary: string;
	/** Workspace origin:sequence IDs or a confirmed session record reference. */
	references: string[];
}
