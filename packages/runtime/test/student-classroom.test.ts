import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTeacherTelemetryExtension } from "@pi-student/runtime/telemetry-integration";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";

const state = { context: {} as Record<string, any>, records: [] as any[], version: 3, joinStatus: "active" as "active" | "pending" };
const project = () => ({
	id: "project", classId: "class", name: "Algorithms", description: "Build a sorter",
	brief: { version: 1 as const, goal: "Build a console sorter", objectives: ["Compare algorithms"], expectations: "Use functions and explain tradeoffs.", structure: ["src/sorter.js", "README.md"], constraints: ["No sorting libraries"], successCriteria: ["Sorts ascending and descending"] },
	policy: { projectId: "project", version: state.version, settings: { ...structuredClone(DEFAULT_CAPABILITY_POLICY), reasoningLevels: ["low", "high"] } },
	requirements: [{ id: "req", title: "Sort numbers", position: 0 }], standards: [{ id: "standard", code: "CS-1" }],
});

function harness() {
	const events = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const contextStore = { read: async () => structuredClone(state.context), write: async (context: any) => { state.context = structuredClone(context); } };
	const repository = {
		joinClass: vi.fn(async () => ({ classId: "class", status: state.joinStatus })),
		listClasses: vi.fn(async () => [{ id: "class", name: "Computer Science", status: "active" as const }]),
		getClass: vi.fn(), listProjects: vi.fn(async () => [project()]),
		getProject: vi.fn(async (id: string) => id === "project" || id === "old" ? { ...project(), id, policy: { ...project().policy, projectId: id } } : undefined),
		saveProjectDraft: vi.fn(), updateProjectBrief: vi.fn(), updateProjectCapabilities: vi.fn(),
	};
	const recordStore = { save: async (record: any) => { state.records.push(structuredClone(record)); }, pending: async () => [], markSynced: vi.fn(), markFailed: vi.fn() };
	const identityProvider = { getIdentity: async () => ({ kind: "student" as const, userId: "student" }) };
	const pi = { on: (name: string, fn: any) => events.set(name, [...events.get(name) ?? [], fn]), registerCommand: (name: string, command: any) => commands.set(name, command), getThinkingLevel: () => "off" };
	createTeacherTelemetryExtension(new WorkflowController(createLearningSession("/tmp/work")), {} as never, {
		identityProvider, telemetrySink: { record: vi.fn(async () => {}) }, contextStore: contextStore as never, recordStore: recordStore as never,
		classroom: { repository: repository as never, identityProvider, authenticator: { signIn: vi.fn() }, contextStore: contextStore as never },
	})(pi as unknown as ExtensionAPI);
	const ctx = { hasUI: true, isIdle: () => true, model: { provider: "test", id: "model" }, ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn(), input: vi.fn(), confirm: vi.fn(async () => false) } };
	return { ctx, commands, emit: async (name: string, event = {}) => { const results = []; for (const fn of events.get(name) ?? []) results.push(await fn(event, ctx)); return results; } };
}

beforeEach(() => { state.context = {}; state.records = []; state.version = 3; state.joinStatus = "active"; vi.clearAllMocks(); });

describe("student classroom session flow", () => {
	it("captures the selected project policy version on startup", async () => {
		state.context = { classId: "class", projectId: "project" };
		const h = harness(); await h.emit("session_start");
		expect(state.records.at(-1).policy).toMatchObject({ projectId: "project", version: 3, settings: { reasoningLevels: ["low", "high"] } });
	});

	it("selects an assignment through the repository and provides its brief", async () => {
		const h = harness(); await h.emit("session_start");
		h.ctx.ui.select.mockResolvedValue("1. Algorithms");
		await h.commands.get("projects").handler("", h.ctx);
		expect(state.context).toMatchObject({ classId: "class", projectId: "project", requirementIds: ["req"], standardIds: ["standard"] });
		const results = await h.emit("before_agent_start", { systemPrompt: "Learn" });
		const prompt = results.find(item => item?.systemPrompt)?.systemPrompt;
		expect(prompt).toContain("Build a sorter");
		expect(prompt).toContain("No sorting libraries");
	});

	it("keeps previous project activity separate when switching", async () => {
		state.context = { classId: "class", projectId: "old" };
		const h = harness(); await h.emit("session_start");
		await h.emit("message_end", { message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 } } });
		h.ctx.ui.select.mockResolvedValue("1. Algorithms");
		await h.commands.get("projects").handler("", h.ctx);
		const previous = state.records.find(item => item.session.projectId === "old" && item.agent.agentTurns === 1);
		expect(previous).toBeDefined();
		expect(state.records.at(-1).session.id).not.toBe(previous.session.id);
	});

	it("does not attribute a pending join to a class", async () => {
		state.joinStatus = "pending";
		const h = harness(); await h.emit("session_start");
		await h.commands.get("join-class").handler("ABC-234", h.ctx);
		expect(state.context).toEqual({});
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("approves"), "info");
	});
});
