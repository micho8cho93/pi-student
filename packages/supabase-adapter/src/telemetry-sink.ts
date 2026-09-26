import type { LearningEvidenceEvent, LearningRecord, TelemetryEvent, TelemetrySink } from "@pi-student/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export class SupabaseTelemetrySink implements TelemetrySink {
	constructor(private readonly client: SupabaseClient) {}
	async record(event: TelemetryEvent): Promise<void> {
		if(event.type === "safety-signal"){const {error}=await this.client.rpc("record_chat_safety_signal",{class_id_input:event.classId,categories_input:event.categories});if(error)throw error;return;}
		if (event.type === "execution-decision") {
			const { error } = await this.client.rpc("record_execution_audit_event", {
				event_id_input: event.eventId, organization_id_input: event.organizationId, class_id_input: event.classId,
				project_id_input: event.projectId, session_id_input: event.sessionId ?? null, action_input: event.action,
				decision_input: event.decision, extension_id_input: event.extensionId ?? null, capability_input: event.capability ?? null,
				stage_input: event.stage ?? null, reason_code_input: event.reasonCode, environment_provider_input: event.environmentProvider ?? null,
				environment_status_input: event.environmentStatus ?? null,
			});
			if (error) throw error;
			return;
		}
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
	const evidence = session.projectId && record.evidence ? boundedEvidence(record.evidence, session.id, session.projectId) : undefined;
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
	if (evidence) {
		const { error: evidenceError } = await client.rpc("replace_session_learning_evidence", {
			session_id_input: session.id, evidence_input: evidence,
		});
		if (evidenceError) throw evidenceError;
	}
}

const fixedSummaries: Partial<Record<LearningEvidenceEvent["category"], string>> = {
	plan_approved: "Student plan approved", test_failed: "Test failed", fix_attempted: "Student edited after a failed test",
	test_passed: "Tests passed", fix_verified: "Tests passed after student's edit", learn_mode_used: "Used Learn Mode for an AI turn",
	question_completed: "Completed /question practice", reflection_completed: "Student confirmed a reflection",
};
const fileSummaries: Partial<Record<LearningEvidenceEvent["category"], RegExp>> = {
	student_edit: /^Student edited [A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
	agent_edit: /^Agent edited [A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
	autocomplete_edit: /^Student accepted AI completion in [A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
	student_revised_agent_work: /^Student revised agent work in [A-Za-z0-9][A-Za-z0-9._-]{0,79}$/,
};

/** Rejects corrupted local caches and sends only the fields the replacement RPC accepts. */
function boundedEvidence(events: LearningEvidenceEvent[], sessionId: string, projectId: string) {
	if (!Array.isArray(events) || events.length > 200) throw new Error("Invalid learning evidence batch.");
	return events.map(event => {
		if (!event || event.sessionId !== sessionId || event.projectId !== projectId || !/^[a-f0-9]{64}$/.test(event.id)
			|| !Number.isFinite(Date.parse(event.timestamp)) || !["student", "agent", "mixed"].includes(event.actor)
			|| !["observed", "deterministic", "classified"].includes(event.source)
			|| (event.source === "classified" ? !(typeof event.confidence === "number" && event.confidence >= 0 && event.confidence <= 1) : event.confidence !== undefined)
			|| typeof event.summary !== "string" || /(?:secret|credential|token|private.?key|sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,})/i.test(event.summary)
			|| !(fixedSummaries[event.category] === event.summary || fileSummaries[event.category]?.test(event.summary))
			|| !Array.isArray(event.references) || event.references.length < 1 || event.references.length > 12
			|| event.references.some(reference => typeof reference !== "string" || !/^([0-9a-f-]{36}:[1-9][0-9]{0,9}|session-reflection:[0-9a-f-]{36})$/.test(reference)))
			throw new Error("Invalid learning evidence event.");
		return { id: event.id, timestamp: event.timestamp, category: event.category, actor: event.actor, source: event.source,
			...(event.confidence === undefined ? {} : { confidence: event.confidence }), summary: event.summary, references: event.references };
	});
}
