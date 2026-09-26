import { describe, expect, it } from "vitest";
import type { WorkspaceEvent } from "@pi-student/contracts";
import { deriveLearningEvidence } from "../src/learning-evidence.js";

const base = Date.parse("2026-09-26T10:00:00.000Z");
const window = { projectId: "project-a", workspaceKey: "workspace-a", sessionId: "d6000000-0000-0000-0000-000000000001", workspaceSessionId: "chat-1",
	startedAt: new Date(base).toISOString(), endedAt: new Date(base + 60 * 60_000).toISOString() };
let sequence = 0;
const event = (minute: number, input: Record<string, unknown>, options: Partial<WorkspaceEvent> = {}): WorkspaceEvent => ({
	...input, seq: ++sequence, origin: "d5000000-0000-0000-0000-000000000001", workspace: "workspace-a", source: "editor",
	at: new Date(base + minute * 60_000).toISOString(), ...options,
} as WorkspaceEvent);

describe("learning evidence projection", () => {
	it("separates student, agent, autocomplete, and a manual revision after agent work", () => {
		const events = [
			event(1, { type: "file.changed", file: "game.py" }),
			event(2, { type: "agent.files_changed", files: [{ file: "game.py", kind: "modified" }] }, { source: "chat" }),
			event(3, { type: "file.changed", file: "game.py" }),
			event(4, { type: "autocomplete.accepted", file: "helper.py" }),
		];
		const result = deriveLearningEvidence(events, window);
		expect(result.map(item => item.category)).toEqual(["student_edit", "agent_edit", "student_revised_agent_work", "autocomplete_edit"]);
		expect(result.find(item => item.category === "student_revised_agent_work")?.references).toEqual([`d5000000-0000-0000-0000-000000000001:${events[1]!.seq}`, `d5000000-0000-0000-0000-000000000001:${events[2]!.seq}`]);
		expect(result.find(item => item.category === "autocomplete_edit")?.actor).toBe("mixed");
	});

	it("connects a failed test, later student edit, and passing test without storing output", () => {
		const events = [
			event(1, { type: "test.failed", command: "pytest", summary: "secret=topsecret\nAssertionError: code is wrong" }, { source: "terminal" }),
			event(2, { type: "file.changed", file: "game.py" }),
			event(3, { type: "test.passed", command: "pytest" }, { source: "terminal" }),
		];
		const result = deriveLearningEvidence(events, window);
		expect(result.map(item => item.category)).toEqual(["test_failed", "student_edit", "fix_attempted", "test_passed", "fix_verified"]);
		expect(JSON.stringify(result)).not.toContain("topsecret");
		expect(JSON.stringify(result)).not.toContain("pytest");
		expect(result.find(item => item.category === "fix_verified")?.source).toBe("deterministic");
	});

	it("records plan approval, Learn Mode, /question, and confirmed reflection", () => {
		const events = [
			event(1, { type: "learning.progress", stage: "plan", understandingReady: true, planApproved: false, verificationPassed: false }, { source: "chat", session: "chat-1" }),
			event(2, { type: "learning.progress", stage: "implement", understandingReady: true, planApproved: true, verificationPassed: false }, { source: "chat", session: "chat-1" }),
			event(3, { type: "chat.prompted", learnMode: true }, { source: "chat", session: "chat-1" }),
			event(4, { type: "question.completed", difficulty: "hard", topic: "loops" }, { source: "question", session: "chat-1" }),
		];
		const result = deriveLearningEvidence(events, { ...window, reflectionConfirmedAt: new Date(base + 5 * 60_000).toISOString() });
		expect(result.map(item => item.category)).toEqual(["plan_approved", "learn_mode_used", "question_completed", "reflection_completed"]);
		expect(result.find(item => item.category === "plan_approved")?.source).toBe("deterministic");
		expect(result.find(item => item.category === "question_completed")?.summary).not.toContain("loops");
	});

	it("filters another project, another chat session, and activity outside the recording window", () => {
		const events = [
			event(1, { type: "file.changed", file: "other.py" }, { workspace: "workspace-b" }),
			event(2, { type: "learn.enabled" }, { source: "learn", session: "chat-2" }),
			event(90, { type: "file.changed", file: "late.py" }),
		];
		expect(deriveLearningEvidence(events, window)).toEqual([]);
	});

	it("groups rapid edits, drops sensitive paths, and rebuilds identically without Laya", () => {
		const events = [
			event(1, { type: "file.changed", file: "game.py" }),
			event(1.5, { type: "file.changed", file: "game.py" }),
			event(2, { type: "file.changed", file: "secret-token.txt" }, { sensitive: true }),
			event(3, { type: "terminal.command_finished", command: "cat private-key", summary: "secret output" }, { source: "terminal" }),
		];
		const first = deriveLearningEvidence(events, window);
		expect(first).toHaveLength(1);
		expect(first[0]?.references).toHaveLength(2);
		expect(deriveLearningEvidence([...events].reverse(), window)).toEqual(first);
		expect(JSON.stringify(first)).not.toMatch(/secret|private-key|output/);
	});

	it("does not count a debounced AI completion as an independent student edit", () => {
		const completion = event(1, { type: "autocomplete.accepted", file: "game.py" });
		const echoedChange = event(1.02, { type: "file.changed", file: "game.py" });
		const result = deriveLearningEvidence([completion, echoedChange], window);
		expect(result.map(item => item.category)).toEqual(["autocomplete_edit"]);
	});

	it("replaces credential-like filenames with a generic label", () => {
		const result = deriveLearningEvidence([event(1, { type: "file.changed", file: "sk-abcdefghijklmnop.py" })], window);
		expect(result[0]?.summary).toBe("Student edited file");
		expect(JSON.stringify(result)).not.toContain("sk-abcdefghijklmnop");
	});
});
