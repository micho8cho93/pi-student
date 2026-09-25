import type { LearningRecord, TelemetryEvent, TelemetrySink } from "@pi-student/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export class SupabaseTelemetrySink implements TelemetrySink {
	constructor(private readonly client: SupabaseClient) {}
	async record(event: TelemetryEvent): Promise<void> {
		if(event.type === "safety-signal"){const {error}=await this.client.rpc("record_chat_safety_signal",{class_id_input:event.classId,categories_input:event.categories});if(error)throw error;return;}
		if (event.type === "learning-record") return uploadLearningRecord(this.client, event.record);
	}
}

export function createSupabaseLearningRecordUploader(client: SupabaseClient): (record: LearningRecord) => Promise<void> {
	return record => uploadLearningRecord(client, record);
}

async function uploadLearningRecord(client: SupabaseClient, record: LearningRecord): Promise<void> {
	const { data: auth, error: authError } = await client.auth.getUser();
	if (authError || !auth.user) throw authError ?? new Error("Sign in before syncing learning records.");
	const session = record.session;
	if (session.studentId && session.studentId !== auth.user.id) throw new Error("Sign in with the student account that created this learning record.");
	const { error } = await client.from("sessions").upsert({
		id: session.id, student_id: auth.user.id, class_id: session.classId, project_id: session.projectId ?? null,
		started_at: session.startedAt, ended_at: session.endedAt, duration_seconds: session.durationSeconds, goal: session.goal ?? null,
		providers: record.agent.providers, models: record.agent.models, thinking_mode: record.agent.thinkingMode ?? null,
		...(record.policy ? { effective_policy: record.policy, policy_compliance: record.policyCompliance ?? { blockedActions: {} } } : {}),
		agent_turn_count: record.agent.agentTurns, input_tokens: record.agent.inputTokens, output_tokens: record.agent.outputTokens, total_tokens: record.agent.totalTokens,
		files_created: record.activity.filesCreated, files_modified: record.activity.filesModified, files_deleted: record.activity.filesDeleted, tests_run: record.activity.testsRun,
		planning_assistance: record.assistance.planning, implementation_assistance: record.assistance.implementation, debugging_assistance: record.assistance.debugging, explanation_assistance: record.assistance.explanation,
		decisions: record.learning.decisions, blockers: record.learning.blockers, questions: record.learning.questions, next_step: record.learning.nextStep || null,
	}, { onConflict: "id" });
	if (error) throw error;
	if (record.learning.requirementIds.length) {
		const { error: linkError } = await client.from("session_requirements").upsert(record.learning.requirementIds.map(requirementId => ({ session_id: session.id, requirement_id: requirementId })), { onConflict: "session_id,requirement_id", ignoreDuplicates: true });
		if (linkError) throw linkError;
	}
	if (record.learning.standardIds.length) {
		const { error: linkError } = await client.from("session_standards").upsert(record.learning.standardIds.map(standardId => ({ session_id: session.id, standard_id: standardId })), { onConflict: "session_id,standard_id", ignoreDuplicates: true });
		if (linkError) throw linkError;
	}
	if (record.reflection) {
		const { error: reflectionError } = await client.from("session_reflections").upsert({ session_id: session.id, student_id: auth.user.id, accomplished: record.reflection.accomplished, important_decision: record.reflection.importantDecision, still_unclear: record.reflection.stillUnclear, next_step: record.reflection.nextStep, confirmed_at: record.reflection.confirmedAt }, { onConflict: "session_id" });
		if (reflectionError) throw reflectionError;
	}
}
