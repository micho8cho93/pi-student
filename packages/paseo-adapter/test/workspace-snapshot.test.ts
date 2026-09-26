import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEffectivePolicy } from "@pi-student/policy/resolution";
import { capabilityState } from "@pi-student/policy/capability-runtime";
import { startBrowserWorkspace, WORKING } from "./browser/workspace-harness.js";

/**
 * The GUI's view of the workspace through the real bridge: one live snapshot per
 * student project and Chat session, derived from the same authorities Chat uses.
 */
let harness: Awaited<ReturnType<typeof startBrowserWorkspace>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });
const headers = { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" };
const action = (snapshot: { actions: Array<{ action: string; available: boolean; reason?: string }> }, name: string) => snapshot.actions.find(item => item.action === name);

describe("live workspace snapshot", () => {
	it("autocomplete reports trusted failures and recovers the bound session, without browser-forged health", async () => {
		harness = await startBrowserWorkspace();
		const h = harness;
		const complete = (agent = "agent-a") => fetch(`${h.bridgeUrl()}/editor-completion?workspaceId=wks_a&agentId=${agent}`, {
			method: "POST", headers, body: JSON.stringify({ filename: "score.js", content: WORKING, cursor: WORKING.length, model: "auto", health: { status: "provider_unavailable" } }),
		});
		expect((await complete()).status).toBe(200);
		expect((await h.snapshot("wks_a")).model.available).toBe(true);
		h.internalError(true);
		expect((await complete()).status).toBe(502);
		expect((await h.snapshot("wks_a")).model.available).toBe(true);
		h.internalError(false);
		h.outage(true);
		expect((await complete()).ok).toBe(false);
		expect((await h.snapshot("wks_a")).model.health).toEqual({ status: "provider_unavailable" });
		expect((await h.snapshot("wks_a", "agent-a2")).model.available).toBe(true);
		expect((await h.snapshot("wks_a", false)).model.available).toBe(true);
		expect((await h.snapshot("wks_b")).model.available).toBe(true);
		h.outage(false);
		expect((await complete("agent-a2")).status).toBe(200);
		expect((await h.snapshot("wks_a")).model.available).toBe(false);
		expect((await complete()).status).toBe(200);
		expect((await h.snapshot("wks_a")).model.health).toEqual({ status: "available" });
	});

	it("follows each Chat session's budget, model health, Learn and progress without mixing sessions of one project", async () => {
		const policy = resolveEffectivePolicy({ projectId: "project-a", delegatedPaths: [],
			organization: { scope: "organization", version: 1, settings: { models: ["school/tutor"], limits: { turns: 1, tutoringTurns: 5 } } } });
		harness = await startBrowserWorkspace({ policy });
		const h = harness;
		const [first, second] = [await h.chat("agent-a"), await h.chat("agent-a2")];
		expect(action(await h.snapshot("wks_a", "agent-a"), "agent-edit")?.available).toBe(true);

		// Chat one reaches its agent budget; only its conversation stops offering agent execution.
		await first.turn();
		expect(capabilityState(first.workflow).agentLimitReached()).toBeTruthy();
		const one = await h.snapshot("wks_a", "agent-a");
		expect(action(one, "agent-edit")).toMatchObject({ available: false, reason: "agent_budget_exhausted" });
		for (const name of ["ask-guidance", "open-editor", "use-terminal", "run-tests"]) expect(action(one, name)?.available).toBe(true);
		expect(one.budget.find((row: { lane: string }) => row.lane === "agent").status).toBe("exhausted");
		expect(action(await h.snapshot("wks_a", "agent-a2"), "agent-edit")?.available).toBe(true);

		// Chat two's provider fails; its conversation reports the outage, then recovers.
		await second.turn({ stopReason: "error", errorMessage: "503 provider unavailable" });
		const outage = await h.snapshot("wks_a", "agent-a2");
		expect(outage.model).toMatchObject({ available: false, reason: "provider_unavailable" });
		expect(outage.fallback.headline).toBe("The AI model is unavailable right now.");
		expect((await h.snapshot("wks_a", "agent-a")).model.available).toBe(true);
		await second.turn();
		expect((await h.snapshot("wks_a", "agent-a2")).model.available).toBe(true);

		// Learn toggled from the GUI for conversation two stays with it.
		const toggled = await fetch(`${h.bridgeUrl()}/learn-mode?workspaceId=wks_a&agentId=agent-a2`, { method: "POST", headers, body: JSON.stringify({ learnMode: true }) });
		expect(toggled.status).toBe(200);
		expect((await h.snapshot("wks_a", "agent-a2")).learn.enabled).toBe(true);
		expect((await h.snapshot("wks_a", "agent-a")).learn.enabled).toBe(false);
		expect((await h.snapshot("wks_a", false)).learn.enabled).toBe(false);

		// Progress is per conversation and live.
		first.workflow.updateLearningState({ currentStage: "understand", goalSummary: "Award two points", understandingReady: true, readyForNextStage: true });
		await h.journal.flush();
		expect((await h.snapshot("wks_a", "agent-a")).learning).toMatchObject({ stage: "plan", source: "live", goal: "Award two points" });
		expect((await h.snapshot("wks_a", "agent-a2")).learning).toMatchObject({ stage: "understand", understandingReady: false });
		// An agent id that is not a registered conversation of this workspace gets a session-less view.
		expect((await h.snapshot("wks_a", "agent-b" as never)).scope.session).toBe(false);
	});

	it("restores project progress from the saved session after the live journal is gone", async () => {
		harness = await startBrowserWorkspace();
		const h = harness;
		const chat = await h.chat("wks_a");
		chat.workflow.updateLearningState({ currentStage: "understand", goalSummary: "Award two points", understandingReady: true, readyForNextStage: true });
		chat.workflow.addStudentPlanStep("Return two points");
		await h.journal.flush();
		expect((await h.snapshot("wks_a")).learning).toMatchObject({ stage: "plan", source: "live", activeStep: "Return two points" });
		// The app restarts: the metadata journal was cleared, the Pi session file remains.
		await rm(path.join(h.journal.directory), { recursive: true, force: true });
		await h.startBridge();
		const restored = await h.snapshot("wks_a");
		expect(restored.learning).toMatchObject({ stage: "plan", source: "saved", goal: "Award two points", activeStep: "Return two points", understandingReady: true });
		const progress = await (await fetch(`${h.bridgeUrl()}/project-progress?workspaceId=wks_a&agentId=agent-a`)).json();
		expect(progress.progress).toMatchObject({ stage: "plan", source: "saved" });
		expect(progress.actions).toEqual(restored.actions);
	});

	it("answers a long-poll only when something the surfaces show changes", async () => {
		harness = await startBrowserWorkspace();
		const h = harness;
		const initial = await h.snapshot("wks_a");
		const started = Date.now();
		const unchanged = await h.snapshot("wks_a", "agent-a", `&since=${initial.revision}&wait=1200`);
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
		expect(unchanged.revision).toBe(initial.revision);
		const waiting = h.snapshot("wks_a", "agent-a", `&since=${initial.revision}&wait=15000`);
		await new Promise(resolve => setTimeout(resolve, 300));
		await fetch(`${h.bridgeUrl()}/workspace-events?workspaceId=wks_a`, { method: "POST", headers, body: JSON.stringify({ type: "file.changed", file: "score.js" }) });
		const changed = await waiting;
		expect(changed.revision).not.toBe(initial.revision);
		expect(changed.activity.recentChanges).toContainEqual(expect.objectContaining({ file: "score.js", author: "student" }));
	});

	it("rejects session state reported by the GUI and never exposes host paths or secrets", async () => {
		harness = await startBrowserWorkspace();
		const h = harness;
		for (const event of [{ type: "learn.enabled" }, { type: "model.health", available: true }, { type: "budget.exhausted", reason: "x" },
			{ type: "learning.progress", stage: "review" }, { type: "chat.prompted", learnMode: true }, { type: "test.passed", command: "npm test" },
			{ type: "file.changed", file: path.join(h.root, "project-b", "score.js") }]) {
			expect((await fetch(`${h.bridgeUrl()}/workspace-events?workspaceId=wks_a`, { method: "POST", headers, body: JSON.stringify(event) })).status).toBe(400);
		}
		await fetch(`${h.bridgeUrl()}/workspace-events?workspaceId=wks_a`, { method: "POST", headers, body: JSON.stringify({ type: "file.changed", file: ".env" }) });
		await fetch(`${h.bridgeUrl()}/workspace-events?workspaceId=wks_a`, { method: "POST", headers, body: JSON.stringify({ type: "terminal.command_finished", command: "npm test", exitCode: 1,
			summary: "FAIL score.test.js > awards two points\nTOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }) });
		const serialized = JSON.stringify(await h.snapshot("wks_a"));
		for (const hidden of [h.root, ".env", "ghp_", "TOKEN="]) expect(serialized).not.toContain(hidden);
		expect(serialized).toContain("score.test.js > awards two points");
	});
});

describe("persisted Map through the bridge", () => {
	it("keeps the last valid map through reloads, restarts and failed regeneration, per project", async () => {
		harness = await startBrowserWorkspace();
		const h = harness;
		const map = (id = "wks_a") => fetch(`${h.bridgeUrl()}/flowchart?workspaceId=${id}`).then(response => response.json());
		expect(await map()).toMatchObject({ chart: null, map: { available: false } });
		const generated = await (await fetch(`${h.bridgeUrl()}/flowchart?workspaceId=wks_a`, { method: "POST", headers, body: "{}" })).json();
		expect(generated.nodes.map((node: { id: string }) => node.id)).toEqual(["start", "score"]);
		expect(generated).not.toHaveProperty("sources");
		await fetch(`${h.bridgeUrl()}/workspace-events?workspaceId=wks_a`, { method: "POST", headers,
			body: JSON.stringify({ type: "flowchart.node_selected", id: "score", label: "Award points", file: "score.js" }) });

		// Restart: the map, its selection and freshness are read from disk, without the model.
		const requests = h.modelRequests.length;
		await h.startBridge();
		const saved = await map();
		expect(saved.chart.generatedAt).toBe(generated.generatedAt);
		expect(saved.map).toMatchObject({ available: true, stale: false, selectedNode: { id: "score", label: "Award points", file: "score.js" } });
		expect(h.modelRequests).toHaveLength(requests);

		// A source change makes it stale, which survives another restart.
		await writeFile(path.join(h.projects.wks_a, "score.js"), WORKING);
		await h.startBridge();
		expect((await map()).map).toMatchObject({ stale: true, staleFiles: ["score.js"] });
		expect((await h.snapshot("wks_a")).map).toMatchObject({ stale: true, staleFiles: ["score.js"] });

		// A failed regeneration reports what still works and leaves the saved map untouched.
		h.outage(true);
		const failed = await fetch(`${h.bridgeUrl()}/flowchart?workspaceId=wks_a`, { method: "POST", headers, body: "{}" });
		expect(failed.status).toBe(502);
		const body = await failed.json();
		expect(body.map).toMatchObject({ available: true, stale: true });
		expect(action(body, "view-map")?.available).toBe(true);
		expect((await map()).chart.generatedAt).toBe(generated.generatedAt);

		// Maps never cross projects.
		expect(await map("wks_b")).toMatchObject({ chart: null, map: { available: false } });
		expect((await h.snapshot("wks_b")).map.available).toBe(false);
		// Source digests stay on the host with the saved map; the GUI receives only the chart.
		const [savedFile] = await readdir(path.join(h.root, "home", "config", "workspace-maps"));
		expect(JSON.parse(await readFile(path.join(h.root, "home", "config", "workspace-maps", savedFile!), "utf8"))).toMatchObject({ sources: { "score.js": expect.any(String) } });
		expect((await map()).chart).not.toHaveProperty("sources");
	});
});

describe("model policy on alternate GUI paths", () => {
	it("never offers or runs a configured but unapproved model, and reports a missing model clearly", async () => {
		const policy = resolveEffectivePolicy({ projectId: "project-a", delegatedPaths: [],
			organization: { scope: "organization", version: 1, settings: { models: ["school/tutor"] } } });
		harness = await startBrowserWorkspace({ policy });
		const h = harness;
		const models = await (await fetch(`${h.bridgeUrl()}/editor-completion/models?workspaceId=wks_a`)).json();
		expect(models.models.map((model: { id: string }) => model.id)).toEqual(["school/tutor"]);
		const rogue = await fetch(`${h.bridgeUrl()}/editor-completion?workspaceId=wks_a`, { method: "POST", headers,
			body: JSON.stringify({ filename: "score.js", content: "return ", cursor: 7, model: "other/rogue" }) });
		expect(rogue.status).toBe(403);
		expect((await h.snapshot("wks_a")).capabilities.models).toEqual(["school/tutor"]);
		// The map is generated with the approved model, even though the unapproved one is listed first by the runtime.
		const chart = await (await fetch(`${h.bridgeUrl()}/flowchart?workspaceId=wks_a`, { method: "POST", headers, body: "{}" })).json();
		expect(chart.model).toBe("school/tutor");

		// Approved by the school, but not configured on this machine.
		const none = resolveEffectivePolicy({ projectId: "project-a", delegatedPaths: [], organization: { scope: "organization", version: 1, settings: { models: ["school/absent"] } } });
		await h.close();
		harness = await startBrowserWorkspace({ policy: none });
		const empty = await harness.snapshot("wks_a");
		expect(empty.model).toEqual({ available: false, reason: "no_model" });
		expect(action(empty, "ask-guidance")).toMatchObject({ available: false, reason: "no_model" });
		for (const name of ["open-editor", "use-terminal", "run-tests"]) expect(action(empty, name)?.available).toBe(true);
	});
});
