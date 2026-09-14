import { randomUUID } from "node:crypto";
import { createStudentClassroomExtension } from "../extensions/student-classroom.js";
import {
	isToolCallEventType,
	type ExtensionContext,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createPiSupabaseClient } from "../teacher/auth.js";
import { readSupabaseConfig } from "../teacher/config.js";
import type { SandboxRuntime } from "../sandbox/types.js";
import type { WorkflowController } from "../workflow/workflow-controller.js";
import { LearningEventBus } from "./events.js";
import { LearningRecordStore, readTeacherContext } from "./local-store.js";
import { SessionRecorder } from "./session-recorder.js";
import { createSupabaseUploader, LearningRecordSyncService } from "./sync-service.js";
import type { StudentReflection, TeacherContext } from "./types.js";
import { capabilityState } from "../education/capability-runtime.js";

const TEST_COMMAND = /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint))\b/i;

export function createTeacherTelemetryExtension(workflow: WorkflowController, sandbox: SandboxRuntime): ExtensionFactory {
	return (pi) => {
		const controls = capabilityState(workflow);
		const bus = new LearningEventBus();
		const recorder = new SessionRecorder(bus);
		const store = new LearningRecordStore();
		const existedBefore = new Map<string, boolean>();
		let latestGoal = workflow.state.goal;
		let activeContext: TeacherContext = {};
		const checkpoint = async (ctx: ExtensionContext) => {
			bus.emit({ type: "SESSION_ENDED" });
			const record = recorder.getRecord();
			if (!record) return;
			if (record.policy) record.policyCompliance = { blockedActions: { ...controls.blocked } };
			await store.save(record);
			const config = readSupabaseConfig();
			if (!config) return;
			const result = await new LearningRecordSyncService(store, createSupabaseUploader(createPiSupabaseClient(config))).syncPending();
			ctx.ui.setStatus("pi-student-sync", result.failed ? "Class sync pending · /sync to retry" : record.session.classId ? "Class record synced" : undefined);
			if (result.failed) ctx.ui.notify("Learning record saved locally. Class sync failed; use /sync to retry after reconnecting.", "warning");
		};
		const safeCheckpoint = async (ctx: ExtensionContext) => {
			try { await checkpoint(ctx); }
			catch { ctx.ui.notify("Could not save or sync the learning record. Use /sync to retry.", "warning"); }
		};
		const startRecord = async (context: TeacherContext, ctx: ExtensionContext) => {
			let studentId: string | undefined;
			try {
				const config = readSupabaseConfig();
				if (config) {
					const { data } = await createPiSupabaseClient(config).auth.getSession();
					studentId = data.session?.user?.id;
				}
			} catch { /* Offline recording remains available. */ }
			activeContext = context;
			controls.select(context.policy);
			controls.unavailable = Boolean(context.projectId && !context.policy);
			bus.emit({ type: "SESSION_STARTED", sessionId: randomUUID(), studentId, context, goal: workflow.state.goal });
			if (ctx.model) bus.emit({ type: "MODEL_SELECTED", provider: ctx.model.provider, model: ctx.model.id });
			bus.emit({ type: "THINKING_LEVEL_CHANGED", level: pi.getThinkingLevel() });
		};
		createStudentClassroomExtension(async (context, ctx) => {
			if (JSON.stringify(activeContext) === JSON.stringify(context)) return;
			// Preserve earlier work under its original project, including personal work.
			await checkpoint(ctx);
			await startRecord(context, ctx);
			await safeCheckpoint(ctx);
		})(pi);
		pi.registerCommand("sync", {
			description: "Save this session and retry pending classroom records",
			handler: async (_args, ctx) => {
				if (!ctx.isIdle()) { ctx.ui.notify("Wait for the response to finish before syncing.", "info"); return; }
				await safeCheckpoint(ctx);
			},
		});
		pi.on("agent_end", async (_event, ctx) => { await safeCheckpoint(ctx); });
		const unsubscribeWorkflow = workflow.onChange(() => {
			const goal = workflow.state.goal?.trim();
			if (goal && goal !== latestGoal) {
				latestGoal = goal;
				bus.emit({ type: "SESSION_GOAL_CHANGED", goal });
			}
		});

		pi.on("session_start", async (_event, ctx) => {
			const context: TeacherContext = await readTeacherContext().catch(() => ({}));
			await startRecord(context, ctx);
			if (context.classId) await safeCheckpoint(ctx);
		});

		pi.on("model_select", async (event) => {
			bus.emit({ type: event.previousModel ? "MODEL_CHANGED" : "MODEL_SELECTED", provider: event.model.provider, model: event.model.id });
		});
		pi.on("thinking_level_select", async (event) => bus.emit({ type: "THINKING_LEVEL_CHANGED", level: event.level }));

		pi.on("message_end", async (event) => {
			if (event.message.role !== "assistant") return;
			bus.emit({
				type: "AGENT_TURN_COMPLETED",
				inputTokens: event.message.usage.input,
				outputTokens: event.message.usage.output,
				totalTokens: event.message.usage.totalTokens,
			});
			bus.emit({ type: workflow.getStage() === "plan" ? "AGENT_HINT_GIVEN" : "AGENT_EXPLANATION_GIVEN" });
		});

		pi.on("tool_call", async (event) => {
			if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
				existedBefore.set(event.toolCallId, await sandbox.fileExists(event.input.path).catch(() => true));
			}
		});
		pi.on("tool_result", async (event) => {
			if (event.isError) return;
			if (event.toolName === "write" || event.toolName === "edit") {
				bus.emit({ type: existedBefore.get(event.toolCallId) ? "FILE_MODIFIED" : "FILE_CREATED" });
				bus.emit({ type: "AGENT_IMPLEMENTATION_GIVEN" });
				existedBefore.delete(event.toolCallId);
			}
			if (event.toolName === "bash") {
				const command = typeof event.input.command === "string" ? event.input.command.trim() : "";
				if (TEST_COMMAND.test(command)) {
					bus.emit({ type: "TEST_EXECUTED" });
					bus.emit({ type: "AGENT_DEBUGGING_GIVEN" });
				}
				if (/^rm\s+/.test(command)) bus.emit({ type: "FILE_DELETED" });
			}
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			try {
				const current = recorder.getRecord();
				if (current && current.agent.agentTurns > 0 && ctx.hasUI && controls.settings.reflection) {
					const reflection = await collectReflection(ctx);
					if (reflection) bus.emit({ type: "STUDENT_REFLECTION_COMPLETED", reflection });
				}
				await checkpoint(ctx);
			} catch {
				if (ctx.hasUI) ctx.ui.notify("Pi could not save this learning record. Your coding session is unaffected.", "warning");
			} finally {
				unsubscribeWorkflow();
				recorder.dispose();
			}
		});
	};
}

async function collectReflection(ctx: ExtensionContext): Promise<StudentReflection | undefined> {
	const wantsReflection = await ctx.ui.confirm(
		"Finish with a learning reflection",
		"Pi stores only your confirmed answers with session metadata. You can cancel and the session will still be saved.",
	);
	if (!wantsReflection) return undefined;
	while (true) {
		const accomplished = await ctx.ui.editor("What did you accomplish?", "Write your answer, then save.");
		if (accomplished === undefined) return undefined;
		const importantDecision = await ctx.ui.editor("What important decision did you make?", "Write your answer, then save.");
		if (importantDecision === undefined) return undefined;
		const stillUnclear = await ctx.ui.editor("What do you still not understand?", "Write 'nothing right now' if nothing is unclear.");
		if (stillUnclear === undefined) return undefined;
		const nextStep = await ctx.ui.editor("What should you do next?", "Write your next step, then save.");
		if (nextStep === undefined) return undefined;
		const reflection = { accomplished: accomplished.trim(), importantDecision: importantDecision.trim(), stillUnclear: stillUnclear.trim(), nextStep: nextStep.trim() };
		const confirmed = await ctx.ui.confirm("Review your reflection", [
			`Accomplished: ${reflection.accomplished || "—"}`,
			`Important decision: ${reflection.importantDecision || "—"}`,
			`Still unclear: ${reflection.stillUnclear || "—"}`,
			`Next step: ${reflection.nextStep || "—"}`,
			"",
			"Confirm these as your own words? Choose No to edit them.",
		].join("\n"));
		if (confirmed) return { ...reflection, confirmedAt: new Date().toISOString() };
	}
}
