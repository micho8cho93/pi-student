import { describe, expect, it, vi } from "vitest";
import { createSupabaseLearningRecordUploader } from "@pi-student/supabase-adapter/telemetry-sink";
import type { LearningRecord } from "@pi-student/contracts";

it("does not upload another student's pending record under the current account", async () => {
	const from = vi.fn();
	const upload = createSupabaseLearningRecordUploader({ auth: { getUser: async () => ({ data: { user: { id: "student-b" } } }) }, from } as never);
	const record = { schemaVersion: 1, session: { id: "session-1", studentId: "student-a", classId: "class-1", startedAt: "2026-09-13T08:00:00Z", endedAt: "2026-09-13T08:01:00Z", durationSeconds: 60 }, agent: { providers: [], models: [], agentTurns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }, activity: { filesCreated: 0, filesModified: 0, filesDeleted: 0, testsRun: 0 }, learning: { requirementIds: [], standardIds: [], decisions: [], blockers: [], questions: [], nextStep: "" }, assistance: { planning: "none", implementation: "none", debugging: "none", explanation: "none" } } satisfies LearningRecord;
	await expect(upload(record)).rejects.toThrow("student account that created");
	expect(from).not.toHaveBeenCalled();
});
