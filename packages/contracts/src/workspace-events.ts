import type { FlowchartNodeSelection } from "./workspace.js";

/** Which student-facing surface produced a workspace event. */
export type WorkspaceSurface = "editor" | "chat" | "terminal" | "flowchart" | "learn" | "question" | "runtime";

/**
 * Metadata-only activity shared between Chat, Code, Flowchart, Terminal, Learn
 * and Question. Events never carry file contents, prompts, or full command output.
 * `file.*` and editor events are student-authored; `autocomplete.accepted` marks
 * AI-suggested text the student accepted; agent edits use `agent.files_changed`.
 * Terminal and test events from the `terminal` surface come from the student's
 * own terminal; the agent's commands are reported by the `chat` surface.
 */
export type WorkspaceEventInput =
	| { type: "file.opened"; file: string }
	| { type: "file.changed"; file: string }
	| { type: "editor.selection_changed"; file: string; startLine: number; endLine: number }
	| { type: "autocomplete.accepted"; file: string }
	| { type: "terminal.command_started"; command: string }
	/** summary: a short, redacted excerpt of error lines, only for failed commands. */
	| { type: "terminal.command_finished"; command: string; exitCode?: number; summary?: string }
	| { type: "test.started"; command: string }
	| { type: "test.passed"; command: string; exitCode?: number }
	/** summary: a short, redacted excerpt of failing lines. failedTests: detected failing test files or names. */
	| { type: "test.failed"; command: string; exitCode?: number; summary?: string; failedTests?: string[] }
	| { type: "flowchart.generated"; filesRead: number; model?: string }
	| { type: "flowchart.stale"; files: string[] }
	| ({ type: "flowchart.node_selected" } & FlowchartNodeSelection)
	| { type: "flowchart.node_cleared" }
	| { type: "chat.prompted"; learnMode: boolean }
	| { type: "agent.files_changed"; files: Array<{ file: string; kind: "created" | "modified" | "deleted" }> }
	| { type: "learn.enabled" }
	| { type: "learn.disabled" }
	| { type: "question.completed"; difficulty: string; topic: string }
	| { type: "model.changed"; model: string }
	| { type: "budget.warning"; reason: string }
	/** lane: "agent" when only AI implementation stopped and tutoring continues; omitted when all AI stopped. */
	| { type: "budget.exhausted"; reason: string; lane?: "agent" }
	/** changed: names of capability settings that differ, or "project" when the workspace scope changed. */
	| { type: "capability.changed"; changed: string[] };

export type WorkspaceEventType = WorkspaceEventInput["type"];

export type WorkspaceEvent = WorkspaceEventInput & {
	/** Monotonic per stream; defines delivery order. */
	readonly seq: number;
	readonly at: string;
	/** Opaque workspace key; events never cross keys. */
	readonly workspace: string;
	readonly source: WorkspaceSurface;
	/** Identifies the writing process so journal replays can be de-duplicated. */
	readonly origin: string;
	/** Set when the event refers to a credential-like path. Such events never reach model context. */
	readonly sensitive?: true;
};
