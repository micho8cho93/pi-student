import type { LearningRecord } from "./types.js";
import { LearningRecordStore } from "./local-store.js";

export type LearningRecordUploader = (record: LearningRecord) => Promise<void>;

export class LearningRecordSyncService {
	constructor(private readonly store: LearningRecordStore, private readonly upload: LearningRecordUploader) {}

	async syncPending(): Promise<{ synced: number; failed: number; skipped: number }> {
		const result = { synced: 0, failed: 0, skipped: 0 };
		for (const stored of await this.store.pending()) {
			if (!stored.record.session.classId) { result.skipped += 1; continue; }
			try {
				await this.upload(stored.record);
				await this.store.markSynced(stored.record.session.id);
				result.synced += 1;
			} catch (error) {
				await this.store.markFailed(stored.record.session.id, safeSyncError(error));
				result.failed += 1;
			}
		}
		return result;
	}
}

function safeSyncError(error: unknown): string {
	const value = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
	return value.replace(/(token|secret|key|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}
