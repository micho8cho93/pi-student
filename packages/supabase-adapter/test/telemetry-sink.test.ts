import { describe, expect, it, vi } from "vitest";
import { createSupabaseLearningRecordUploader, SupabaseTelemetrySink } from "@pi-student/supabase-adapter/telemetry-sink";
import type { LearningRecord } from "@pi-student/contracts";

it("does not upload another student's pending record under the current account", async () => {
	const from = vi.fn();
	const upload = createSupabaseLearningRecordUploader({ auth: { getUser: async () => ({ data: { user: { id: "student-b" } } }) }, from } as never);
	const record = { schemaVersion: 1, session: { id: "session-1", studentId: "student-a", classId: "class-1", startedAt: "2026-09-13T08:00:00Z", endedAt: "2026-09-13T08:01:00Z", durationSeconds: 60 }, agent: { providers: [], models: [], agentTurns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }, activity: { filesCreated: 0, filesModified: 0, filesDeleted: 0, testsRun: 0 }, learning: { requirementIds: [], standardIds: [], decisions: [], blockers: [], questions: [], nextStep: "" }, assistance: { planning: "none", implementation: "none", debugging: "none", explanation: "none" } } satisfies LearningRecord;
	await expect(upload(record)).rejects.toThrow("student account that created");
	expect(from).not.toHaveBeenCalled();
});

it("records only safe execution decision fields", async () => {
	const rpc = vi.fn(async () => ({ data: null, error: null }));
	const sink = new SupabaseTelemetrySink({ rpc } as never);
	await sink.record({ type: "execution-decision", eventId: "event-1", organizationId: "org-1", classId: "class-1", projectId: "project-1",
		action: "mcp.call", decision: "denied", extensionId: "extension-1", capability: "database", stage: "implement",
		reasonCode: "host-not-allowlisted", environmentProvider: "gondolin", environmentStatus: "active" });
	expect(rpc).toHaveBeenCalledWith("record_execution_audit_event", expect.objectContaining({
		event_id_input: "event-1", organization_id_input: "org-1", extension_id_input: "extension-1", reason_code_input: "host-not-allowlisted",
	}));
	const payload = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
	expect(Object.keys(payload)).not.toContain("secret");
	expect(Object.keys(payload)).not.toContain("arguments");
});
