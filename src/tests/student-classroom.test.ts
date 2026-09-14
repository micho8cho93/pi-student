import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTeacherTelemetryExtension } from "../telemetry/pi-integration.js";
import { WorkflowController } from "../workflow/workflow-controller.js";
import { createLearningSession } from "../workflow/types.js";
import { DEFAULT_CAPABILITY_POLICY } from "../education/capability-policy.js";

const mocks = vi.hoisted(() => ({
	context: {} as Record<string, unknown>, records: [] as any[],
	sync: vi.fn(async () => ({ synced: 1, failed: 0, skipped: 0 })),
	query: vi.fn(), join: vi.fn(), login: vi.fn(),
}));
vi.mock("../telemetry/local-store.js", () => ({
	readTeacherContext: async () => mocks.context,
	writeTeacherContext: async (context: any) => { mocks.context = context; },
	LearningRecordStore: class { async save(record: any) { mocks.records.push(structuredClone(record)); } },
}));
vi.mock("../teacher/config.js", () => ({ readSupabaseConfig: () => ({ url: "https://example.supabase.co", publishableKey: "public" }) }));
vi.mock("../teacher/auth.js", () => ({ createPiSupabaseClient: () => ({
	auth: { getSession: async () => ({ data: { session: {} } }), getUser: async () => ({ data: { user: { id: "student" } } }) },
	from: (table: string) => {
		const builder: any = { select: () => builder, eq: () => builder, order: () => mocks.query(table) };
		return builder;
	},
}) }));
vi.mock("../teacher/commands.js", () => ({ authenticateInBrowser: mocks.login }));
vi.mock("../teacher/class-service.js", () => ({ joinClass: mocks.join }));
vi.mock("../telemetry/sync-service.js", () => ({ createSupabaseUploader: vi.fn(), LearningRecordSyncService: class { syncPending = mocks.sync; } }));

function harness() {
	const events = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const pi = { on: (name: string, fn: any) => events.set(name, [...events.get(name) ?? [], fn]), registerCommand: (name: string, command: any) => commands.set(name, command), getThinkingLevel: () => "off" };
	createTeacherTelemetryExtension(new WorkflowController(createLearningSession("/tmp/work")), {} as never)(pi as unknown as ExtensionAPI);
	const ctx = { hasUI: true, isIdle: () => true, model: { provider: "test", id: "model" }, ui: { notify: vi.fn(), setStatus: vi.fn(), select: vi.fn(), input: vi.fn(), confirm: vi.fn(async () => false) } };
	return { ctx, commands, emit: async (name: string, event = {}) => { const results = []; for (const fn of events.get(name) ?? []) results.push(await fn(event, ctx)); return results; } };
}
beforeEach(() => {
	mocks.context = {}; mocks.records = []; vi.clearAllMocks();
	mocks.sync.mockResolvedValue({ synced: 1, failed: 0, skipped: 0 });
	mocks.query.mockImplementation(async table => ({ data: table === "class_members" ? [{ class_id: "class", status: "active", classes: { name: "Computer Science" } }] : [{ id: "project", name: "Algorithms", description: "Build a sorter", brief: { version: 1, goal: "Build a console sorter", objectives: ["Compare algorithms"], expectations: "Use functions and explain tradeoffs.", structure: ["src/sorter.js", "README.md"], constraints: ["No sorting libraries"], successCriteria: ["Sorts ascending and descending"] }, project_requirements: [{ id: "req", title: "Sort numbers", position: 0 }], project_standards: [{ standards: { id: "standard" } }] }] }));
});
describe("student classroom session flow", () => {
	it("captures the saved project version on startup and preserves it when switching policies", async () => {
		const original = mocks.query.getMockImplementation()!;
		let version = 3;
		mocks.query.mockImplementation(async table => {
			const result = await original(table);
			if (table === "projects") result.data[0] = { ...result.data[0], policy_version: version, capability_policy: { ...structuredClone(DEFAULT_CAPABILITY_POLICY), reasoningLevels: ["low", "high"] } };
			return result;
		});
		mocks.context = { classId: "class", projectId: "project" };
		const h = harness(); await h.emit("session_start");
		expect(mocks.records.at(-1).policy).toMatchObject({ projectId: "project", version: 3, settings: { reasoningLevels: ["low", "high"] } });
		version = 4; h.ctx.ui.select.mockResolvedValue("1. Algorithms · selected");
		await h.commands.get("projects").handler("", h.ctx);
		expect(mocks.records.at(-1).policy.version).toBe(4);
		expect(mocks.records[0].policy.version).toBe(3);
		expect(mocks.records[0].session.id).not.toBe(mocks.records.at(-1).session.id);
	});
	it("saves and syncs a class session even before its first prompt and on close", async () => {
		mocks.context = { classId: "class" };
		const h = harness(); await h.emit("session_start");
		expect(mocks.records[0].session.classId).toBe("class");
		expect(mocks.records[0].agent.agentTurns).toBe(0);
		await h.emit("session_shutdown");
		expect(mocks.sync).toHaveBeenCalledTimes(2);
	});
	it("selects an assignment before the first prompt and provides its brief to the agent", async () => {
		const h = harness(); await h.emit("session_start");
		h.ctx.ui.select.mockResolvedValue("1. Algorithms");
		await h.commands.get("projects").handler("", h.ctx);
		expect(mocks.context).toMatchObject({ classId: "class", projectId: "project", requirementIds: ["req"], standardIds: ["standard"] });
		const results = await h.emit("before_agent_start", { systemPrompt: "Learn" });
		expect(results.find(item => item?.systemPrompt)?.systemPrompt).toContain("Build a sorter");
		expect(results.find(item => item?.systemPrompt)?.systemPrompt).toContain("No sorting libraries");
		expect(results.find(item => item?.systemPrompt)?.systemPrompt).toContain("materially conflicts with the assignment");
		expect(mocks.records.at(-1).session.projectId).toBe("project");
	});
	it("keeps previous project activity separate when switching midway", async () => {
		mocks.context = { classId: "class", projectId: "old" };
		const h = harness(); await h.emit("session_start");
		await h.emit("message_end", { message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 } } });
		h.ctx.ui.select.mockResolvedValue("1. Algorithms");
		await h.commands.get("projects").handler("", h.ctx);
		const previous = mocks.records.find(item => item.session.projectId === "old" && item.agent.agentTurns === 1);
		const next = mocks.records.at(-1);
		expect(previous).toBeDefined();
		expect(next.session.id).not.toBe(previous.session.id);
		expect(next.agent.agentTurns).toBe(0);
		expect(next.learning.standardIds).toEqual(["standard"]);
	});
	it("keeps a cancelled project picker from changing session attribution", async () => {
		mocks.context = { classId: "class", projectId: "old" };
		const h = harness(); await h.emit("session_start");
		h.ctx.ui.select.mockResolvedValue(undefined);
		await h.commands.get("projects").handler("", h.ctx);
		expect(mocks.context.projectId).toBe("old");
	});
	it("keeps pending joins personal until teacher approval", async () => {
		const h = harness(); await h.emit("session_start");
		mocks.join.mockResolvedValue({ classId: "class", status: "pending" });
		await h.commands.get("join-class").handler("ABC-234", h.ctx);
		expect(mocks.records).toHaveLength(0);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("approves"), "info");
	});
	it("keeps failed sync retryable without breaking the coding session", async () => {
		mocks.context = { classId: "class" };
		mocks.sync.mockResolvedValue({ synced: 0, failed: 1, skipped: 0 });
		const h = harness(); await h.emit("session_start");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("saved locally"), "warning");
		mocks.sync.mockResolvedValue({ synced: 1, failed: 0, skipped: 0 });
		await h.commands.get("sync").handler("", h.ctx);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-student-sync", "Class record synced");
	});
});
