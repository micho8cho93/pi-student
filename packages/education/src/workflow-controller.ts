import { canTransition } from "./transitions.js";
import { toolPolicy, type ToolPolicy } from "@pi-student/policy/tool-policy";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import { addStudentPlanStep, approveStudentPlan } from "./student-plan.js";
import type { LearningSession, LearningStage, LearningStateUpdate } from "./types.js";
import type { IntentRoute, LearningIntent } from "./intent.js";
import type { ProjectContext } from "./project-context.js";

export class InvalidTransitionError extends Error {
	constructor(readonly from: LearningStage, readonly to: LearningStage) {
		super(`Illegal learning-stage transition: ${from} -> ${to}`);
		this.name = "InvalidTransitionError";
	}
}

export class LearningStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LearningStateError";
	}
}

export class WorkflowController {
	private readonly changeListeners = new Set<() => void>();

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private readonly stageListeners = new Set<(stage: LearningStage) => void>();

	constructor(
		public readonly state: LearningSession,
		private readonly policy: ToolPolicy = toolPolicy,
	) {}

	isExploring(): boolean { return this.state.learnMode === true || !!this.state.question; }

	setLearnMode(enabled: boolean): void {
		if (this.state.learnMode === enabled) return;
		this.state.learnMode = enabled;
		this.touch();
	}

	setQuestion(question: LearningSession["question"]): void {
		this.state.question = question;
		this.touch();
	}

	getStage(): LearningStage {
		return this.state.stage;
	}

	setRoutingContext(route: IntentRoute, projectContext: ProjectContext): void {
		this.state.intent = route.intent;
		this.state.intentRoute = route;
		this.state.projectContext = projectContext;
		this.touch();
	}

	getIntent(): LearningIntent | undefined {
		return this.state.intent;
	}

	getAllowedTools(): readonly string[] {
		if (!this.isExploring()) return this.policy.allowedTools(this.state.stage);
		return [...this.policy.allowedTools(this.state.stage).filter(tool => ["read", "grep", "find", "ls", "bash"].includes(tool) && this.policy.canUseTool(this.state.stage, tool)), "codebase_model"];
	}

	getRegisteredTools(): readonly string[] {
		return [...this.policy.registeredTools(), "codebase_model"];
	}

	canTransition(nextStage: LearningStage): boolean {
		return canTransition(this.state.stage, nextStage);
	}

	onStageChange(listener: (stage: LearningStage) => void): () => void {
		this.stageListeners.add(listener);
		return () => this.stageListeners.delete(listener);
	}

	canUseTool(toolName: string): boolean {
		return this.isExploring() ? this.getAllowedTools().includes(toolName) : this.policy.canUseTool(this.state.stage, toolName);
	}

	addStudentPlanStep(description: string): void {
		if (this.state.stage !== "plan") {
			throw new LearningStateError("Student plan steps can only be added during PLAN");
		}
		addStudentPlanStep(this.state.plan, description);
		this.touch();
	}

	approveStudentPlan(acknowledgement: string): void {
		if (this.state.stage !== "plan") {
			throw new LearningStateError("A student plan can only be approved during PLAN");
		}
		approveStudentPlan(this.state.plan, acknowledgement);
		this.touch();
	}

	/**
	 * Apply model-reported learning progress. The model can describe progress,
	 * but only this controller can commit a legal stage change.
	 */
	updateLearningState(update: LearningStateUpdate): void {
		if (update.currentStage !== this.state.stage) {
			throw new LearningStateError(
				`Stale learning update for ${update.currentStage}; current stage is ${this.state.stage}`,
			);
		}
		if (update.studentApprovedPlan) {
			throw new LearningStateError(
				"The agent cannot approve a plan on the student's behalf; use the student plan approval interaction",
			);
		}

		// Validate a detached candidate first so a rejected transition cannot
		// leave summaries or completion flags partially committed.
		const candidate: LearningSession = {
			...this.state,
			understanding: { ...this.state.understanding },
			plan: {
				...this.state.plan,
				steps: this.state.plan.steps.map((step) => ({ ...step })),
				concerns: [...this.state.plan.concerns],
				studentAcknowledgements: [...this.state.plan.studentAcknowledgements],
			},
			implementation: {
				filesChanged: [...this.state.implementation.filesChanged],
				actions: [...this.state.implementation.actions],
			},
			verification: { ...this.state.verification, commands: [...this.state.verification.commands] },
			reflection: { ...this.state.reflection, studentMessages: [...this.state.reflection.studentMessages] },
		};

		if (update.goalSummary?.trim()) candidate.goal = update.goalSummary.trim();
		if (update.understandingReady !== undefined) candidate.understanding.ready = update.understandingReady;
		if (update.planSummary?.trim()) candidate.plan.summary = update.planSummary.trim();
		if (update.studentApprovedPlan === false) candidate.plan.approved = false;
		if (update.verificationStrategy?.trim()) {
			candidate.verification.strategy = update.verificationStrategy.trim();
		}
		if (update.verificationPassed !== undefined) {
			candidate.verification.passed = update.verificationPassed;
		}
		if (update.reflectionComplete !== undefined) {
			candidate.reflection.complete = update.reflectionComplete;
		}

		let nextStage: LearningStage | undefined;
		if (update.readyForNextStage) {
			this.assertReadyForTransition(candidate);
			nextStage = nextStageFor(candidate.stage, update, candidate.verification.passed);
			if (nextStage) {
				if (!canTransition(candidate.stage, nextStage)) {
					throw new InvalidTransitionError(candidate.stage, nextStage);
				}
				this.prepareStageEntry(candidate, candidate.stage, nextStage);
				candidate.stage = nextStage;
			}
		}

		candidate.updatedAt = new Date().toISOString();
		Object.assign(this.state, candidate);
		for (const listener of this.changeListeners) listener();
		if (nextStage) {
			for (const listener of this.stageListeners) listener(nextStage);
		}
	}

	getState(): LearningSession {
		return this.state;
	}

	private assertReadyForTransition(candidate: LearningSession): void {
		switch (candidate.stage) {
			case "understand":
				if (!candidate.goal || !candidate.understanding.ready) {
					throw new LearningStateError(
						"UNDERSTAND requires a goal and understanding.ready before PLAN",
					);
				}
				break;
			case "plan":
				if (!candidate.plan.summary || candidate.plan.steps.length === 0 || !candidate.plan.approved) {
					throw new LearningStateError(
						"PLAN requires student-authored steps, a plan summary, and explicit student approval before IMPLEMENT",
					);
				}
				break;
			case "implement":
				break;
			case "review":
				break;
			case "verify":
				if (candidate.verification.passed === undefined) {
					throw new LearningStateError(
						"VERIFY requires verificationPassed to be reported before leaving the stage",
					);
				}
				break;
			case "reflect":
				if (capabilityState(this).settings.reflection && !candidate.reflection.complete) {
					throw new LearningStateError("REFLECT requires reflectionComplete=true before completion");
				}
				break;
		}
	}

	private prepareStageEntry(candidate: LearningSession, from: LearningStage, to: LearningStage): void {
		if (to === "plan" && from !== "understand") {
			candidate.plan.approved = false;
			candidate.plan.summary = undefined;
		}
		if ((from === "plan" && to === "implement") || (from === "implement" && to === "review")) {
			candidate.verification.passed = undefined;
			candidate.verification.commands = [];
			candidate.reflection.complete = false;
		}
	}

	private touch(): void {
		this.state.updatedAt = new Date().toISOString();
		for (const listener of this.changeListeners) listener();
	}
}

function nextStageFor(
	stage: LearningStage,
	update: LearningStateUpdate,
	verificationPassed: boolean | undefined,
): LearningStage | undefined {
	if (stage === "reflect") {
		if (update.requestedNextStage) throw new InvalidTransitionError(stage, update.requestedNextStage);
		return undefined;
	}

	const defaultNextStage: LearningStage = stage === "understand"
		? "plan"
		: stage === "plan"
			? "implement"
			: stage === "implement"
				? "review"
				: stage === "review"
					? "verify"
					: verificationPassed ? "reflect" : "implement";
	const nextStage = update.requestedNextStage ?? defaultNextStage;
	if (stage === "verify" && nextStage !== defaultNextStage) {
		throw new LearningStateError(
			`VERIFY must proceed to ${defaultNextStage.toUpperCase()} when verification ${verificationPassed ? "passes" : "fails"}`,
		);
	}
	return nextStage;
}
