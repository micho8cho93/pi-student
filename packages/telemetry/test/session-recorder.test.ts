import { describe, expect, it } from "vitest";
import { LearningEventBus } from "@pi-student/telemetry/events";
import { SessionRecorder } from "@pi-student/telemetry/session-recorder";

describe("session learning recorder", () => {
	it("builds a privacy-preserving learning record from core events", () => {
		const bus = new LearningEventBus();
		const recorder = new SessionRecorder(bus);
		bus.emit({ type: "SESSION_STARTED", sessionId: "session-1", at: "2026-09-13T08:00:00.000Z", goal: "Implement authentication", context: { organizationId: "organization-1", classId: "class-1", projectId: "project-1", requirementIds: ["requirement-1"], standardIds: ["standard-1"] } });
		bus.emit({ type: "MODEL_SELECTED", provider: "openai", model: "gpt-a" });
		bus.emit({ type: "MODEL_CHANGED", provider: "anthropic", model: "claude-b" });
		bus.emit({ type: "THINKING_LEVEL_CHANGED", level: "guided" });
		bus.emit({ type: "AGENT_TURN_COMPLETED", inputTokens: 100, outputTokens: 40, totalTokens: 140 });
		bus.emit({ type: "AGENT_TURN_COMPLETED", inputTokens: 60, outputTokens: 20, totalTokens: 80 });
		bus.emit({ type: "FILE_CREATED" });
		bus.emit({ type: "FILE_MODIFIED" });
		bus.emit({ type: "FILE_DELETED" });
		bus.emit({ type: "TEST_EXECUTED" });
		bus.emit({ type: "AGENT_IMPLEMENTATION_GIVEN" });
		bus.emit({ type: "AGENT_IMPLEMENTATION_GIVEN" });
		bus.emit({ type: "STUDENT_DECISION_RECORDED", value: "Use OAuth" });
		bus.emit({ type: "BLOCKER_RECORDED", value: "Redirect URL is unclear" });
		bus.emit({ type: "QUESTION_RECORDED", value: "How does PKCE work?" });
		bus.emit({ type: "STUDENT_REFLECTION_COMPLETED", reflection: { accomplished: "Added sign-in", importantDecision: "Used OAuth", stillUnclear: "Token refresh", nextStep: "Protect routes", confirmedAt: "2026-09-13T08:25:00.000Z" } });
		bus.emit({ type: "SESSION_ENDED", at: "2026-09-13T08:25:00.000Z" });

		const record = recorder.getRecord();
		expect(record?.session).toMatchObject({ id: "session-1", organizationId: "organization-1", classId: "class-1", projectId: "project-1", durationSeconds: 1500, goal: "Implement authentication" });
		expect(record?.agent).toEqual({ providers: ["openai", "anthropic"], models: ["openai/gpt-a", "anthropic/claude-b"], thinkingMode: "guided", agentTurns: 2, inputTokens: 160, outputTokens: 60, totalTokens: 220 });
		expect(record?.activity).toEqual({ filesCreated: 1, filesModified: 1, filesDeleted: 1, testsRun: 1 });
		expect(record?.assistance.implementation).toBe("moderate");
		expect(record?.learning).toMatchObject({ decisions: ["Use OAuth"], blockers: ["Redirect URL is unclear"], questions: ["How does PKCE work?"], nextStep: "Protect routes" });
		expect(record?.reflection?.accomplished).toBe("Added sign-in");
		expect(JSON.stringify(record)).not.toMatch(/api.?key|source.?code|transcript/i);
	});
});
