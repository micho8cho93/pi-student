import { createHash } from "node:crypto";
import type { LearningEvidenceActor, LearningEvidenceCategory, LearningEvidenceEvent, LearningEvidenceSource, WorkspaceEvent } from "@pi-student/contracts";

export interface EvidenceWindow {
	projectId: string;
	/** Authenticated student/project workspace hash; rejects events from other streams. */
	workspaceKey: string;
	sessionId: string;
	/** The workspace event session, which differs from the learning-record UUID. */
	workspaceSessionId?: string;
	startedAt: string;
	endedAt: string;
	reflectionConfirmedAt?: string;
}

const EDIT_GROUP_MS = 2 * 60_000;
const RELATED_MS = 60 * 60_000;
const MAX_EVIDENCE = 200;
const sourceId = (event: WorkspaceEvent) => event.sourceId ?? `${event.origin}:${event.seq}`;
const validSourceId = (id: string) => /^[0-9a-f-]{36}:[1-9][0-9]{0,9}$/.test(id);
const time = (value: string) => Date.parse(value);
const safeFile = (file: string) => {
	const name = file.split("/").at(-1) ?? "";
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name)
		&& !/(?:\.env|secret|credential|token|private.?key|sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]{8,})/i.test(name) ? name : "file";
};

/**
 * Pure projection of authoritative records. Project events are associated with
 * a session only by time; the event journal itself does not label their session.
 * Replaying the same source records produces the same IDs and output.
 */
export function deriveLearningEvidence(events: readonly WorkspaceEvent[], window: EvidenceWindow): LearningEvidenceEvent[] {
	const start = time(window.startedAt), end = time(window.endedAt);
	if (!window.projectId || !window.workspaceKey || !window.sessionId || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
	const selected = events.filter(event => event.workspace === window.workspaceKey && !event.sensitive && validSourceId(sourceId(event))
		&& Number.isFinite(time(event.at)) && time(event.at) >= start && time(event.at) <= end
		&& (event.session === undefined || event.session === window.workspaceSessionId))
		.sort((a, b) => time(a.at) - time(b.at) || sourceId(a).localeCompare(sourceId(b)));
	const output: LearningEvidenceEvent[] = [];
	const add = (category: LearningEvidenceCategory, actor: LearningEvidenceActor, source: LearningEvidenceSource,
		at: string, summary: string, references: string[]) => {
		const refs = [...new Set(references)].slice(0, 12);
		const id = createHash("sha256").update(JSON.stringify([window.projectId, window.sessionId, category, refs])).digest("hex");
		output.push({ id, timestamp: at, projectId: window.projectId, sessionId: window.sessionId, category, actor, source, summary, references: refs });
	};
	const lastAgentEdit = new Map<string, WorkspaceEvent>();
	const lastAutocomplete = new Map<string, WorkspaceEvent>();
	let failed: WorkspaceEvent | undefined;
	let attempted: WorkspaceEvent | undefined;
	let planApproved = false;
	let planSeen = false;
	let learnUsed = false;
	const revised = new Set<string>();
	const grouped = new Map<string, { event: WorkspaceEvent; refs: string[]; count: number; index: number }>();
	const edit = (category: "student_edit" | "agent_edit" | "autocomplete_edit", actor: LearningEvidenceActor,
		file: string, event: WorkspaceEvent) => {
		const key = `${category}:${file}`;
		const prior = grouped.get(key);
		if (prior && time(event.at) - time(prior.event.at) <= EDIT_GROUP_MS) {
			prior.event = event;
			prior.refs.push(sourceId(event));
			prior.count++;
			const item = output[prior.index]!;
			item.references = [...new Set(prior.refs)].slice(0, 12);
			item.id = createHash("sha256").update(JSON.stringify([window.projectId, window.sessionId, category, item.references])).digest("hex");
			item.summary = `${actor === "student" ? "Student" : actor === "agent" ? "Agent" : "Student accepted AI completion in"} ${actor === "mixed" ? "" : "edited "}${safeFile(file)}`.replace(/  +/g, " ");
			return;
		}
		const summary = category === "autocomplete_edit" ? `Student accepted AI completion in ${safeFile(file)}` : `${actor === "student" ? "Student" : "Agent"} edited ${safeFile(file)}`;
		add(category, actor, "observed", event.at, summary, [sourceId(event)]);
		grouped.set(key, { event, refs: [sourceId(event)], count: 1, index: output.length - 1 });
	};
	for (const event of selected) {
		if (event.type === "learning.progress") {
			if (planSeen && event.planApproved && !planApproved) add("plan_approved", "student", "deterministic", event.at, "Student plan approved", [sourceId(event)]);
			planApproved = event.planApproved;
			planSeen = true;
		} else if (event.type === "file.changed" && event.source === "editor") {
			// The editor may debounce a file.changed after applying an accepted AI completion.
			const completion = lastAutocomplete.get(event.file);
			if (completion && time(event.at) - time(completion.at) <= 3_000) continue;
			edit("student_edit", "student", event.file, event);
			const agent = lastAgentEdit.get(event.file);
			if (agent && time(event.at) - time(agent.at) <= RELATED_MS && !revised.has(sourceId(agent) + event.file)) {
				add("student_revised_agent_work", "student", "deterministic", event.at, `Student revised agent work in ${safeFile(event.file)}`, [sourceId(agent), sourceId(event)]);
				revised.add(sourceId(agent) + event.file);
			}
			if (failed && time(event.at) - time(failed.at) <= RELATED_MS && !attempted) {
				attempted = event;
				add("fix_attempted", "student", "deterministic", event.at, "Student edited after a failed test", [sourceId(failed), sourceId(event)]);
			}
		} else if (event.type === "autocomplete.accepted" && event.source === "editor") {
			edit("autocomplete_edit", "mixed", event.file, event);
			lastAutocomplete.set(event.file, event);
		} else if (event.type === "agent.files_changed" && event.source === "chat") {
			for (const change of event.files) {
				edit("agent_edit", "agent", change.file, event);
				lastAgentEdit.set(change.file, event);
			}
		} else if (event.type === "test.failed") {
			failed = event;
			attempted = undefined;
			add("test_failed", event.source === "terminal" ? "student" : "agent", "observed", event.at, "Test failed", [sourceId(event)]);
		} else if (event.type === "test.passed") {
			add("test_passed", event.source === "terminal" ? "student" : "agent", "observed", event.at, "Tests passed", [sourceId(event)]);
			if (failed && attempted && time(event.at) - time(failed.at) <= RELATED_MS)
				add("fix_verified", event.source === "terminal" ? "student" : "mixed", "deterministic", event.at,
					"Tests passed after student's edit", [sourceId(failed), sourceId(attempted), sourceId(event)]);
			failed = attempted = undefined;
		} else if (event.type === "chat.prompted" && event.learnMode && !learnUsed) {
			learnUsed = true;
			add("learn_mode_used", "student", "observed", event.at, "Used Learn Mode for an AI turn", [sourceId(event)]);
		} else if (event.type === "question.completed") {
			add("question_completed", "student", "observed", event.at, "Completed /question practice", [sourceId(event)]);
		}
	}
	if (window.reflectionConfirmedAt && Number.isFinite(time(window.reflectionConfirmedAt)) && time(window.reflectionConfirmedAt) >= start && time(window.reflectionConfirmedAt) <= end)
		add("reflection_completed", "student", "observed", window.reflectionConfirmedAt, "Student confirmed a reflection", [`session-reflection:${window.sessionId}`]);
	return output.sort((a, b) => time(a.timestamp) - time(b.timestamp) || a.id.localeCompare(b.id)).slice(-MAX_EVIDENCE);
}
