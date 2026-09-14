import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningRecordStore } from "../telemetry/local-store.js";
import { LearningRecordSyncService } from "../telemetry/sync-service.js";
import type { LearningRecord } from "../telemetry/types.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))));

function record(id = "session-1"): LearningRecord {
	return { schemaVersion: 1, session: { id, classId: "class-1", startedAt: "2026-09-13T08:00:00Z", endedAt: "2026-09-13T08:01:00Z", durationSeconds: 60 }, agent: { providers: [], models: [], agentTurns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 }, activity: { filesCreated: 0, filesModified: 0, filesDeleted: 0, testsRun: 0 }, learning: { requirementIds: [], standardIds: [], decisions: [], blockers: [], questions: [], nextStep: "" }, assistance: { planning: "none", implementation: "none", debugging: "none", explanation: "none" } };
}

async function tempStore() {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-learning-records-"));
	temporaryDirectories.push(directory);
	return new LearningRecordStore(directory);
}

describe("learning record sync", () => {
	it("uploads once and marks a stable session id as synced", async () => {
		const store = await tempStore(); await store.save(record());
		const upload = vi.fn(async () => {});
		const sync = new LearningRecordSyncService(store, upload);
		expect(await sync.syncPending()).toEqual({ synced: 1, failed: 0, skipped: 0 });
		expect(await sync.syncPending()).toEqual({ synced: 0, failed: 0, skipped: 0 });
		expect(upload).toHaveBeenCalledTimes(1);
	});

	it("keeps offline failures pending and retries later", async () => {
		const store = await tempStore(); await store.save(record());
		const upload = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
		const sync = new LearningRecordSyncService(store, upload);
		expect(await sync.syncPending()).toEqual({ synced: 0, failed: 1, skipped: 0 });
		expect((await store.read("session-1"))?.attempts).toBe(1);
		expect(await sync.syncPending()).toEqual({ synced: 1, failed: 0, skipped: 0 });
	});

	it("leaves standalone records local", async () => {
		const store = await tempStore(); const standalone = record(); delete standalone.session.classId; await store.save(standalone);
		const upload = vi.fn(async () => {});
		expect(await new LearningRecordSyncService(store, upload).syncPending()).toEqual({ synced: 0, failed: 0, skipped: 1 });
		expect(upload).not.toHaveBeenCalled();
	});
});


it("uploads updated activity after an earlier checkpoint was synced", async () => {
 const store = await tempStore();
 const initial = record();
 await store.save(initial);
 const upload = vi.fn(async () => {});
 const sync = new LearningRecordSyncService(store, upload);
 await sync.syncPending();
 initial.agent.agentTurns = 2;
 await store.save(initial);
 expect(await sync.syncPending()).toEqual({ synced: 1, failed: 0, skipped: 0 });
 expect(upload).toHaveBeenLastCalledWith(expect.objectContaining({ agent: expect.objectContaining({ agentTurns: 2 }) }));
});

it("does not upload another student's pending record under the current account", async () => {
 const { createSupabaseUploader } = await import("../telemetry/sync-service.js");
 const from = vi.fn();
 const upload = createSupabaseUploader({ auth: { getUser: async () => ({ data: { user: { id: "student-b" } } }) }, from } as never);
 const saved = record(); saved.session.studentId = "student-a";
 await expect(upload(saved)).rejects.toThrow("student account that created");
 expect(from).not.toHaveBeenCalled();
});
