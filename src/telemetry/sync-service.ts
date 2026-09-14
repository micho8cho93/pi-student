import type { SupabaseClient } from "@supabase/supabase-js";
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

export function createSupabaseUploader(client: SupabaseClient): LearningRecordUploader {
	return async (record) => {
		const { data: auth, error: authError } = await client.auth.getUser();
		if (authError || !auth.user) throw authError ?? new Error("Sign in before syncing learning records.");
		const session = record.session;
		if (session.studentId && session.studentId !== auth.user.id) throw new Error("Sign in with the student account that created this learning record.");
		const { error } = await client.from("sessions").upsert({
			id: session.id,
			student_id: auth.user.id,
			class_id: session.classId,
			project_id: session.projectId ?? null,
			started_at: session.startedAt,
			ended_at: session.endedAt,
			duration_seconds: session.durationSeconds,
			goal: session.goal ?? null,
			providers: record.agent.providers,
			models: record.agent.models,
			thinking_mode: record.agent.thinkingMode ?? null,
			...(record.policy ? { effective_policy: record.policy, policy_compliance: record.policyCompliance ?? { blockedActions: {} } } : {}),
			agent_turn_count: record.agent.agentTurns,
			input_tokens: record.agent.inputTokens,
			output_tokens: record.agent.outputTokens,
			total_tokens: record.agent.totalTokens,
			files_created: record.activity.filesCreated,
			files_modified: record.activity.filesModified,
			files_deleted: record.activity.filesDeleted,
			tests_run: record.activity.testsRun,
			planning_assistance: record.assistance.planning,
			implementation_assistance: record.assistance.implementation,
			debugging_assistance: record.assistance.debugging,
			explanation_assistance: record.assistance.explanation,
			decisions: record.learning.decisions,
			blockers: record.learning.blockers,
			questions: record.learning.questions,
			next_step: record.learning.nextStep || null,
		}, { onConflict: "id" });
		if (error) throw error;

		if (record.learning.requirementIds.length) {
			const { error: linkError } = await client.from("session_requirements").upsert(
				record.learning.requirementIds.map(requirementId => ({ session_id: session.id, requirement_id: requirementId })),
				{ onConflict: "session_id,requirement_id", ignoreDuplicates: true },
			);
			if (linkError) throw linkError;
		}
		if (record.learning.standardIds.length) {
			const { error: linkError } = await client.from("session_standards").upsert(
				record.learning.standardIds.map(standardId => ({ session_id: session.id, standard_id: standardId })),
				{ onConflict: "session_id,standard_id", ignoreDuplicates: true },
			);
			if (linkError) throw linkError;
		}
		if (record.reflection) {
			const { error: reflectionError } = await client.from("session_reflections").upsert({
				session_id: session.id,
				student_id: auth.user.id,
				accomplished: record.reflection.accomplished,
				important_decision: record.reflection.importantDecision,
				still_unclear: record.reflection.stillUnclear,
				next_step: record.reflection.nextStep,
				confirmed_at: record.reflection.confirmedAt,
			}, { onConflict: "session_id" });
			if (reflectionError) throw reflectionError;
		}
	};
}

function safeSyncError(error: unknown): string {
	const value = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
	return value.replace(/(token|secret|key|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}
