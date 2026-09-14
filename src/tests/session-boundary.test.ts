import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createInteractiveSessionManager, createLearningAgentSession } from "../pi/create-session.js";
import { HostRuntime } from "../sandbox/host-runtime.js";
import { SANDBOX_WORKSPACE } from "../sandbox/types.js";
import { createLearningSession } from "../workflow/types.js";
import { WorkflowController } from "../workflow/workflow-controller.js";
import { BUNDLED_THEME_NAMES } from "../terminal/themes.js";

describe("interactive session boundary", () => {
	it("persists against the host project while reserving /workspace for the sandbox", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-student-session-"));
		const project = path.join(root, "project");
		const sessionDir = path.join(root, "sessions");

		try {
			await mkdir(project);
			const manager = createInteractiveSessionManager(project, sessionDir);

			expect(manager.getCwd()).toBe(project);
			expect(manager.getCwd()).not.toBe(SANDBOX_WORKSPACE);
			expect(path.dirname(manager.getSessionFile() ?? "")).toBe(sessionDir);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("registers future-stage tools while exposing only the current stage", async () => {
		const project = await mkdtemp(path.join(os.tmpdir(), "pi-student-tools-"));
		const sandbox = new HostRuntime();
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		const workflow = new WorkflowController(createLearningSession(project));
		let agent: Awaited<ReturnType<typeof createLearningAgentSession>> | undefined;

		try {
			agent = await createLearningAgentSession(project, workflow, modelRuntime, undefined, sandbox);
			expect(agent.session.resourceLoader.getSkills().skills).toHaveLength(0);
			expect(agent.session.extensionRunner.getRegisteredCommands().map(command => command.name)).not.toEqual(
			expect.arrayContaining(["stage", "status", "themes", "decision", "blocker", "question"]),
		);
			expect(agent.session.resourceLoader.getThemes().themes.map(({ name }) => name)).toEqual(
				expect.arrayContaining([...BUNDLED_THEME_NAMES]),
			);

			expect(agent.session.getAllTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
				"student_plan",
				"edit",
				"write",
				"save_to_desktop",
			]));
			expect(agent.session.getActiveToolNames()).not.toContain("student_plan");
			expect(agent.session.getActiveToolNames()).not.toContain("write");

			workflow.updateLearningState({
				currentStage: "understand",
				readyForNextStage: true,
				goalSummary: "Create a small site",
				understandingReady: true,
				reason: "The requested behavior is clear",
			});

			expect(agent.session.getActiveToolNames()).toContain("student_plan");
			expect(agent.session.getActiveToolNames()).not.toContain("write");

			workflow.addStudentPlanStep("Create the site files");
			workflow.approveStudentPlan("I reviewed and approve this plan.");
			workflow.updateLearningState({
				currentStage: "plan",
				readyForNextStage: true,
				planSummary: "Create the site files",
				reason: "The student approved the plan",
			});

			expect(agent.session.getActiveToolNames()).toEqual(expect.arrayContaining([
				"student_plan",
				"edit",
				"write",
			]));
		} finally {
			agent?.dispose();
			await sandbox.stop();
			await rm(project, { recursive: true, force: true });
		}
	});
});
