import { expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";
import { createTeacherTelemetryExtension } from "../src/telemetry-integration.js";

it("saves a derived evidence snapshot and exposes the same safe summary to the student", async () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const saved: unknown[] = [];
	const deriveEvidence = vi.fn(async (record: { session: { projectId?: string; id: string } }) => [{
		id: "a".repeat(64), timestamp: "2026-09-26T10:00:00Z", projectId: record.session.projectId!, sessionId: record.session.id,
		category: "test_failed" as const, actor: "student" as const, source: "observed" as const,
		summary: "Test failed", references: ["d5000000-0000-0000-0000-000000000001:1"],
	}]);
	const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		getThinkingLevel: () => "off" };
	createTeacherTelemetryExtension(new WorkflowController(createLearningSession("/tmp/work")), {} as never, {
		contextStore: { read: async () => ({ classId: "class-1", projectId: "project-1" }) } as never,
		identityProvider: { getIdentity: async () => ({ kind: "student" as const, userId: "student-1" }) },
		recordStore: { save: async (record: unknown) => { saved.push(structuredClone(record)); } } as never,
		deriveEvidence,
	})(pi as unknown as ExtensionAPI);
	const ctx = { isIdle: () => true, ui: { notify: vi.fn(), setStatus: vi.fn() } };
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	expect(deriveEvidence).toHaveBeenCalledOnce();
	expect(saved.at(-1)).toMatchObject({ evidence: [{ summary: "Test failed", source: "observed" }] });
	await commands.get("timeline")!.handler("", ctx);
	expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Test failed"), "info");
});
