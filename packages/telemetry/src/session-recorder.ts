import { ASSISTANCE_LEVELS, type AssistanceLevel, type LearningRecord } from "./types.js";
import type { LearningEvent, LearningEventBus } from "./events.js";
import { redactSensitiveText } from "./privacy.js";

type AssistanceArea = keyof LearningRecord["assistance"];

interface MutableState {
	record?: LearningRecord;
	assistanceCounts: Record<AssistanceArea, number>;
	lastTokenTotals: { input: number; output: number; total: number };
}

export class SessionRecorder {
	private readonly state: MutableState = {
		assistanceCounts: { planning: 0, implementation: 0, debugging: 0, explanation: 0 },
		lastTokenTotals: { input: 0, output: 0, total: 0 },
	};
	private readonly unsubscribe: () => void;

	constructor(bus: LearningEventBus) {
		this.unsubscribe = bus.subscribe(event => this.consume(event));
	}

	dispose(): void { this.unsubscribe(); }

	getRecord(): LearningRecord | undefined {
		return this.state.record ? structuredClone(this.state.record) : undefined;
	}

	private consume(event: Readonly<LearningEvent>): void {
		if (event.type === "SESSION_STARTED") {
			this.state.assistanceCounts = { planning: 0, implementation: 0, debugging: 0, explanation: 0 };
			const startedAt = event.at ?? new Date().toISOString();
			this.state.record = {
				...(event.context?.policy ? { policy: structuredClone(event.context.policy) } : {}),
				schemaVersion: 1,
				session: {
					id: event.sessionId,
					studentId: event.studentId,
					organizationId: event.context?.organizationId,
					classId: event.context?.classId,
					projectId: event.context?.projectId,
					startedAt,
					endedAt: startedAt,
					durationSeconds: 0,
					goal: event.goal ? redactSensitiveText(event.goal) : undefined,
				},
				agent: { providers: [], models: [], agentTurns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				activity: { filesCreated: 0, filesModified: 0, filesDeleted: 0, testsRun: 0 },
				learning: {
					requirementIds: [...new Set(event.context?.requirementIds ?? [])],
					standardIds: [...new Set(event.context?.standardIds ?? [])],
					decisions: [], blockers: [], questions: [], nextStep: "",
				},
				assistance: { planning: "none", implementation: "none", debugging: "none", explanation: "none" },
			};
			return;
		}
		const record = this.state.record;
		if (!record) return;
		switch (event.type) {
			case "SESSION_ENDED": {
				record.session.endedAt = event.at ?? new Date().toISOString();
				record.session.durationSeconds = Math.max(0, Math.round((Date.parse(record.session.endedAt) - Date.parse(record.session.startedAt)) / 1000));
				break;
			}
			case "CLASS_SELECTED": record.session.classId = event.classId; break;
			case "PROJECT_SELECTED": record.session.projectId = event.projectId; break;
			case "REQUIREMENT_SELECTED": addUnique(record.learning.requirementIds, event.requirementId); break;
			case "STANDARD_SELECTED": addUnique(record.learning.standardIds, event.standardId); break;
			case "SESSION_GOAL_CHANGED": record.session.goal = redactSensitiveText(event.goal); break;
			case "MODEL_SELECTED":
			case "MODEL_CHANGED":
				addUnique(record.agent.providers, event.provider);
				addUnique(record.agent.models, `${event.provider}/${event.model}`);
				break;
			case "THINKING_LEVEL_CHANGED": record.agent.thinkingMode = event.level; break;
			case "AGENT_TURN_COMPLETED":
				record.agent.agentTurns += 1;
				this.addTokenDelta(record, event);
				break;
			case "FILE_CREATED": record.activity.filesCreated += 1; break;
			case "FILE_MODIFIED": record.activity.filesModified += 1; break;
			case "FILE_DELETED": record.activity.filesDeleted += 1; break;
			case "TEST_EXECUTED": record.activity.testsRun += 1; break;
			case "AGENT_HINT_GIVEN": this.increaseAssistance(record, "planning"); break;
			case "AGENT_IMPLEMENTATION_GIVEN": this.increaseAssistance(record, "implementation"); break;
			case "AGENT_DEBUGGING_GIVEN": this.increaseAssistance(record, "debugging"); break;
			case "AGENT_EXPLANATION_GIVEN": this.increaseAssistance(record, "explanation"); break;
			case "STUDENT_DECISION_RECORDED": addUnique(record.learning.decisions, event.value); break;
			case "BLOCKER_RECORDED": addUnique(record.learning.blockers, event.value); break;
			case "QUESTION_RECORDED": addUnique(record.learning.questions, event.value); break;
			case "STUDENT_REFLECTION_COMPLETED":
				record.reflection = {
					...event.reflection,
					accomplished: redactSensitiveText(event.reflection.accomplished),
					importantDecision: redactSensitiveText(event.reflection.importantDecision),
					stillUnclear: redactSensitiveText(event.reflection.stillUnclear),
					nextStep: redactSensitiveText(event.reflection.nextStep),
				};
				record.learning.nextStep = record.reflection.nextStep;
				break;
		}
	}

	private addTokenDelta(record: LearningRecord, event: Extract<LearningEvent, { type: "AGENT_TURN_COMPLETED" }>): void {
		// Provider message usage is per response in Pi today. Guarding against a
		// cumulative source as well prevents negative or duplicated totals.
		const input = Math.max(0, event.inputTokens ?? 0);
		const output = Math.max(0, event.outputTokens ?? 0);
		const total = Math.max(0, event.totalTokens ?? input + output);
		record.agent.inputTokens += input;
		record.agent.outputTokens += output;
		record.agent.totalTokens += total;
		this.state.lastTokenTotals = { input, output, total };
	}

	private increaseAssistance(record: LearningRecord, area: AssistanceArea): void {
		const count = ++this.state.assistanceCounts[area];
		record.assistance[area] = levelForCount(count);
	}
}

function addUnique(values: string[], value: string): void {
	const normalized = redactSensitiveText(value.trim());
	if (normalized && !values.includes(normalized)) values.push(normalized);
}

export function levelForCount(count: number): AssistanceLevel {
	return ASSISTANCE_LEVELS[Math.min(ASSISTANCE_LEVELS.length - 1, Math.max(0, count))] ?? "none";
}
