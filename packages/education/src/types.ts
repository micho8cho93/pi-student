import { createStudentPlan, type StudentPlan } from "./student-plan.js";
import type { LearningIntent, IntentRoute } from "./intent.js";
import type { ProjectContext } from "./project-context.js";
import type { LearningStage } from "@pi-student/contracts";

export type { LearningStage } from "@pi-student/contracts";

export interface LearningSession {
	readonly id: string;
	readonly cwd: string;
	stage: LearningStage;
	learnMode?: boolean;
	question?: { difficulty: "easy" | "medium" | "hard"; topic: string; phase: "generate" | "answer" };
	intent?: LearningIntent;
	intentRoute?: IntentRoute;
	projectContext?: ProjectContext;
	goal?: string;
	understanding: {
		studentMessages: string[];
		ready: boolean;
	};
	plan: StudentPlan;
	implementation: {
		filesChanged: string[];
		actions: string[];
	};
	verification: {
		strategy?: string;
		commands: string[];
		passed?: boolean;
	};
	reflection: {
		studentMessages: string[];
		complete: boolean;
	};
	createdAt: string;
	updatedAt: string;
}

export interface LearningStateUpdate {
	currentStage: LearningStage;
	readyForNextStage: boolean;
	goalSummary?: string;
	understandingReady?: boolean;
	planSummary?: string;
	studentApprovedPlan?: boolean;
	requestedNextStage?: LearningStage;
	verificationStrategy?: string;
	verificationPassed?: boolean;
	reflectionComplete?: boolean;
	reason: string;
}

export function createLearningSession(cwd: string, id = crypto.randomUUID()): LearningSession {
	const now = new Date().toISOString();
	return {
		id,
		cwd,
		stage: "understand",
		understanding: { studentMessages: [], ready: false },
		plan: createStudentPlan(),
		implementation: { filesChanged: [], actions: [] },
		verification: { commands: [] },
		reflection: { studentMessages: [], complete: false },
		createdAt: now,
		updatedAt: now,
	};
}
