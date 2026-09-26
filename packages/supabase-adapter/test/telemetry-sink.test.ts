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

it("syncs only bounded evidence rows after the owning session", async () => {
	const calls: string[] = [];
	const rpc = vi.fn(async (_name: string, args: Record<string, unknown>) => { calls.push("evidence"); return { data: args, error: null }; });
	const from = vi.fn((table: string) => ({ upsert: async () => { calls.push(table); return { error: null }; } }));
	const upload = createSupabaseLearningRecordUploader({ auth: { getUser: async () => ({ data: { user: { id: "student-a" } } }) }, from, rpc } as never);
	const record: LearningRecord = {
		schemaVersion: 1, session: { id: "session-1", studentId: "student-a", classId: "class-1", projectId: "project-1",
			startedAt: "2026-09-26T10:00:00Z", endedAt: "2026-09-26T10:01:00Z", durationSeconds: 60 },
		agent: { providers: [], models: [], agentTurns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
		activity: { filesCreated: 0, filesModified: 0, filesDeleted: 0, testsRun: 0 },
		learning: { requirementIds: [], standardIds: [], decisions: [], blockers: [], questions: [], nextStep: "" },
		assistance: { planning: "none", implementation: "none", debugging: "none", explanation: "none" },
		evidence: [{ id: "a".repeat(64), timestamp: "2026-09-26T10:00:30Z", projectId: "project-1", sessionId: "session-1",
			category: "test_failed", actor: "student", source: "observed", summary: "Test failed", references: ["d5000000-0000-0000-0000-000000000001:1"] }],
	};
	await upload(record);
	expect(calls).toEqual(["sessions", "evidence"]);
	expect(rpc).toHaveBeenCalledWith("replace_session_learning_evidence", { session_id_input: "session-1", evidence_input: [{
		id: record.evidence![0]!.id, timestamp: record.evidence![0]!.timestamp, category: "test_failed", actor: "student", source: "observed",
		summary: "Test failed", references: record.evidence![0]!.references,
	}] });
	expect(JSON.stringify(rpc.mock.calls)).not.toContain("raw terminal");
	rpc.mockClear();
	await expect(upload({ ...record, evidence: [{ ...record.evidence![0]!, summary: "raw terminal output" }] })).rejects.toThrow("Invalid learning evidence event");
	expect(rpc).not.toHaveBeenCalled();
});
