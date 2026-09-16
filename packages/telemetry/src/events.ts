import type { StudentReflection, TeacherContext } from "./types.js";

interface BaseEvent { at?: string }

export type LearningEvent =
	| (BaseEvent & { type: "SESSION_STARTED"; sessionId: string; studentId?: string; context?: TeacherContext; goal?: string })
	| (BaseEvent & { type: "SESSION_ENDED" })
	| (BaseEvent & { type: "CLASS_SELECTED"; classId: string })
	| (BaseEvent & { type: "PROJECT_SELECTED"; projectId: string })
	| (BaseEvent & { type: "REQUIREMENT_SELECTED"; requirementId: string })
	| (BaseEvent & { type: "STANDARD_SELECTED"; standardId: string })
	| (BaseEvent & { type: "SESSION_GOAL_CHANGED"; goal: string })
	| (BaseEvent & { type: "MODEL_SELECTED" | "MODEL_CHANGED"; provider: string; model: string })
	| (BaseEvent & { type: "THINKING_LEVEL_CHANGED"; level: string })
	| (BaseEvent & { type: "AGENT_TURN_COMPLETED"; inputTokens?: number; outputTokens?: number; totalTokens?: number })
	| (BaseEvent & { type: "FILE_CREATED" | "FILE_MODIFIED" | "FILE_DELETED" })
	| (BaseEvent & { type: "TEST_EXECUTED" })
	| (BaseEvent & { type: "AGENT_HINT_GIVEN" | "AGENT_EXPLANATION_GIVEN" | "AGENT_IMPLEMENTATION_GIVEN" | "AGENT_DEBUGGING_GIVEN" })
	| (BaseEvent & { type: "STUDENT_DECISION_RECORDED"; value: string })
	| (BaseEvent & { type: "BLOCKER_RECORDED"; value: string })
	| (BaseEvent & { type: "QUESTION_RECORDED"; value: string })
	| (BaseEvent & { type: "STUDENT_REFLECTION_COMPLETED"; reflection: StudentReflection });

export type LearningEventListener = (event: Readonly<LearningEvent>) => void;

/** A deliberately small synchronous application event bus, shared by every UI. */
export class LearningEventBus {
	private readonly listeners = new Set<LearningEventListener>();

	emit(event: LearningEvent): void {
		const timestamped = event.at ? event : { ...event, at: new Date().toISOString() };
		for (const listener of this.listeners) listener(timestamped);
	}

	subscribe(listener: LearningEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

