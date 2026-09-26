import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelAdmissionDecision } from "@pi-student/contracts";
import { resolveEffectivePolicy } from "@pi-student/policy/resolution";
import { FileTeacherContextStore } from "@pi-student/telemetry/local-store";
import { resolveExecutionContext } from "@pi-student/runtime/execution-context";
import { WorkspaceMapStore } from "@pi-student/runtime/workspace-map-store";
import { workspaceEventKey, WorkspaceEventJournal, WorkspaceEventStream } from "@pi-student/runtime/workspace-events";
import { createEcosystemBridgeServer } from "../src/ecosystem-bridge.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

const headers = { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" };
const CONVERSATIONS = [{ agent: "agent-a", session: "session-a" }, { agent: "agent-a2", session: "session-a2" }] as const;

/**
 * The real bridge over one project path shared by students on one machine. The
 * identity layer, control plane (execution context) and admission are controlled:
 * `signIn` sets who the trusted identity layer says is signed in, or makes it fail.
 */
async function classroom(options: { managed?: boolean } = {}) {
	const managed = options.managed ?? true;
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-identity-")));
	const previousHome = process.env.PI_STUDENT_HOME;
	process.env.PI_STUDENT_HOME = path.join(root, "home");
	cleanup.push(async () => {
		if (previousHome === undefined) delete process.env.PI_STUDENT_HOME; else process.env.PI_STUDENT_HOME = previousHome;
		await rm(root, { recursive: true, force: true });
	});
	const paseoHome = path.join(root, "paseo");
	const project = path.join(root, "project-a");
	await mkdir(path.join(paseoHome, "projects"), { recursive: true });
	await mkdir(project);
	await writeFile(path.join(project, "score.js"), "export function score() { return 0; }\n");
	await writeFile(path.join(paseoHome, "projects", "workspaces.json"), JSON.stringify([{ workspaceId: "wks_a", cwd: project }]));
	const agents = path.join(paseoHome, "agents", project.replace(/^\//, "").replace(/[\\/]/g, "-"));
	await mkdir(agents, { recursive: true });
	for (const { agent, session } of CONVERSATIONS) {
		await writeFile(path.join(agents, `${agent}.json`), JSON.stringify({ id: agent, provider: "pi-student", workspaceId: "wks_a", cwd: project, runtimeInfo: { sessionId: session } }));
	}
	const policy = resolveEffectivePolicy({ projectId: "project-a", delegatedPaths: [], organization: { scope: "organization", version: 1, settings: { models: ["school/tutor"] } } });
	const selection = new FileTeacherContextStore();
	if (managed) await selection.write({ workspacePath: project, projectId: "project-a", classId: "class-a", organizationId: "school" });

	let student: string | undefined | Error;
	const identity = async () => { if (student instanceof Error) throw student; return student ? { userId: student } : {}; };
	/** The control plane authorizes whoever the identity layer resolved; a managed project without one fails. */
	const context = async (cwd: string) => {
		const signedIn = await identity().catch(() => ({} as { userId?: string }));
		return resolveExecutionContext({ workspacePath: cwd, selection: await selection.read(),
			identityProvider: { getIdentity: async () => signedIn.userId ? { kind: "student" as const, userId: signedIn.userId } : { kind: "personal" as const } },
			policyProvider: { resolvePolicy: async () => policy },
			scopeProvider: { resolve: async projectId => ({ projectId, classId: "class-a", organizationId: "school", userId: signedIn.userId! }) },
			environmentProvider: { resolve: async () => ({ sandbox: { mode: "gondolin" as const }, skills: [], mcps: [] }) } });
	};
	/** Host admission: an institutional decision per student, as the organization ledger reports it. */
	const decisions = new Map<string, ModelAdmissionDecision>();
	const admissions: Array<{ userId?: string; sessionId?: string; purpose?: string }> = [];
	const admission = (userId: string | undefined) => ({ check: async (_projectId: string, _provider: string, _model: string, _thinking: unknown, sessionId?: string, purpose?: string) => {
		admissions.push({ userId, sessionId, purpose });
		return decisions.get(userId ?? "") ?? { warning: false, blocked: false };
	} });
	const model = { provider: "school", id: "tutor", name: "Tutor", reasoning: false, cost: { input: 0, output: 0 } };
	const runtime = {
		getAvailable: async () => [model], getProviderAuthStatus: () => ({ configured: true }),
		completeSimple: async (_model: unknown, request: { systemPrompt: string }) => ({ stopReason: "stop", content: [{ type: "text",
			text: request.systemPrompt.startsWith("Complete code") ? "2" : JSON.stringify({ title: "Score", summary: "Points", edges: [],
				nodes: [{ id: "score", label: "Award points", type: "action", file: "score.js", symbol: "score" }] }) }] }),
	} as unknown as ModelRuntime;
	const server = createEcosystemBridgeServer(project, paseoHome, { resolveIdentity: identity,
		resolveModelExecution: async cwd => { const resolved = await context(cwd); return { runtime, context: resolved, admission: admission(resolved.identity.userId) }; } });
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const get = async (endpoint: string, agent?: string) => {
		const response = await fetch(`${base}/${endpoint}?workspaceId=wks_a${agent ? `&agentId=${agent}` : ""}`);
		return { status: response.status, body: await response.json() };
	};
	const post = async (endpoint: string, body: object, agent?: string) => {
		const response = await fetch(`${base}/${endpoint}?workspaceId=wks_a${agent ? `&agentId=${agent}` : ""}`, { method: "POST", headers, body: JSON.stringify(body) });
		return { status: response.status, body: await response.json() };
	};
	const snapshot = async (agent?: string) => (await get("workspace-snapshot", agent)).body;
	const journal = new WorkspaceEventJournal();
	cleanup.push(() => journal.flush());
	/** What a Chat process for `userId`'s session publishes into the shared journal. */
	const chatScope = (userId: string | undefined, sessionId: string) => ({ projectPath: project, ...(managed ? { projectId: "project-a", organizationId: "school" } : {}),
		...(userId ? { userId } : {}), sessionId });
	const publish = async (userId: string | undefined, sessionId: string, event: Record<string, unknown>) => {
		new WorkspaceEventStream({ journal }).emit(chatScope(userId, sessionId), "chat", event);
		await journal.flush();
	};
	const stored = async () => [...await readdir(journal.directory).catch(() => [] as string[]), ...await readdir(new WorkspaceMapStore().directory).catch(() => [] as string[])].sort();
	return { project, get, post, snapshot, publish, stored, decisions, admissions, journal,
		signIn: (value: string | undefined | Error) => { student = value; } };
}

const lane = (snapshot: { budget: Array<{ lane: string; status: string }> }, name: string) => snapshot.budget.find(row => row.lane === name)?.status;
const action = (snapshot: { actions: Array<{ action: string; available: boolean; reason?: string }> }, name: string) => snapshot.actions.find(item => item.action === name);

describe("managed workspace identity", () => {
	it("keeps Alice's activity, map, Learn and progress away from Bob in the same project path", async () => {
		const h = await classroom();
		h.signIn("alice");
		expect((await h.post("workspace-events", { type: "file.changed", file: "score.js" })).status).toBe(202);
		expect((await h.post("flowchart", {})).status).toBe(200);
		expect((await h.post("workspace-events", { type: "flowchart.node_selected", id: "score", label: "Award points", file: "score.js" })).status).toBe(202);
		await h.publish("alice", "session-a", { type: "learn.enabled" });
		await h.publish("alice", "session-a", { type: "learning.progress", stage: "implement", goal: "Alice's goal" });
		const alice = await h.snapshot("agent-a");
		expect(alice.activity.recentChanges).toHaveLength(1);
		expect(alice.map).toMatchObject({ available: true, selectedNode: { id: "score" } });
		expect(alice.learn.enabled).toBe(true);

		h.signIn("bob");
		const bob = await h.snapshot("agent-a");
		expect(bob.scope).toMatchObject({ managed: true, session: true });
		expect(bob.activity.recentChanges).toEqual([]);
		expect(bob.map.available).toBe(false);
		expect(bob.learn.enabled).toBe(false);
		expect(bob.learning.source).not.toBe("live");
		expect(JSON.stringify(bob)).not.toContain("Alice's goal");
		expect((await h.get("flowchart")).body.chart).toBeNull();
		expect((await h.get("workspace-activity", "agent-a")).body).toMatchObject({ openFiles: [], recentChanges: [] });
	});

	it("fails closed when identity lookup fails after Alice used the project", async () => {
		const h = await classroom();
		h.signIn("alice");
		await h.post("workspace-events", { type: "file.changed", file: "score.js" });
		await h.post("flowchart", {});
		await h.publish("alice", "session-a", { type: "learn.enabled" });
		await h.publish("alice", "session-a", { type: "budget.exhausted", reason: "Alice's budget", lane: "agent" });
		// Anonymous class-project state left by an older version must not be served either.
		await h.publish(undefined, "session-a", { type: "learning.progress", stage: "review", goal: "Anonymous goal" });
		await new WorkspaceMapStore().save({ projectPath: h.project, projectId: "project-a", organizationId: "school" },
			{ title: "Anonymous", nodes: [{ id: "anon", label: "Anonymous map" }], edges: [], generatedAt: new Date().toISOString(), filesRead: 1 }, {});
		const before = await h.stored();

		for (const failure of [new Error("identity service unreachable"), undefined]) {
			h.signIn(failure);
			for (const agent of [undefined, "agent-a"]) {
				const snapshot = await h.snapshot(agent);
				expect(snapshot.scope).toEqual({ managed: true, session: false, identityRequired: true });
				expect(snapshot.activity).toEqual({ recentChanges: [] });
				expect(snapshot.map).toEqual({ available: false, stale: false, staleFiles: [] });
				expect(snapshot.learn.enabled).toBe(false);
				expect(snapshot.learning).toMatchObject({ source: "default" });
				expect(snapshot.model).toEqual({ available: false, reason: "identity_required" });
				expect(snapshot.fallback.headline).toContain("Sign in");
				// Manual local work stays usable.
				for (const name of ["open-editor", "use-terminal", "run-tests"]) expect(action(snapshot, name)?.available).toBe(true);
				expect(action(snapshot, "agent-edit")).toMatchObject({ available: false, reason: "identity_required" });
				expect(JSON.stringify(snapshot)).not.toMatch(/Alice's|Anonymous|score\.js/);
			}
			for (const response of [await h.get("workspace-activity", "agent-a"), await h.get("flowchart"), await h.get("learn-mode", "agent-a"),
				await h.post("workspace-events", { type: "file.changed", file: "score.js" }), await h.post("learn-mode", { learnMode: true }, "agent-a")]) {
				expect(response).toMatchObject({ status: 403, body: { workspace: "identity_required" } });
			}
			expect((await h.get("workspace-actions", "agent-a")).body).toMatchObject({ workspace: "identity_required", managed: true });
			expect((await h.get("project-progress", "agent-a")).body).toMatchObject({ progress: null, managed: true });
			// Nothing was written: no journal or map for an anonymous student, Alice's files untouched.
			expect(await h.stored()).toEqual(before);
		}

		// Once the identity layer resolves Alice again, her workspace is back.
		h.signIn("alice");
		const restored = await h.snapshot("agent-a");
		expect(restored.activity.recentChanges).toHaveLength(1);
		expect(restored.learn.enabled).toBe(true);
	});

	it("keeps a personal workspace working without login", async () => {
		const h = await classroom({ managed: false });
		h.signIn(new Error("offline"));
		expect((await h.post("workspace-events", { type: "file.changed", file: "score.js" })).status).toBe(202);
		expect((await h.post("flowchart", {})).status).toBe(200);
		const snapshot = await h.snapshot();
		expect(snapshot.scope).toEqual({ managed: false, session: false });
		expect(snapshot.activity.recentChanges).toHaveLength(1);
		expect(snapshot.map.available).toBe(true);
		expect((await h.get("flowchart")).body.chart.nodes).toHaveLength(1);
		expect((await h.post("learn-mode", { learnMode: true }, "agent-a")).status).toBe(200);
		expect((await h.snapshot("agent-a")).learn.enabled).toBe(true);
	});
});

describe("admission and budget presentation", () => {
	const complete = (h: Awaited<ReturnType<typeof classroom>>) => h.post("editor-completion", { filename: "score.js", content: "return ", cursor: 7, model: "auto" });

	it("shows a student's institutional limits in all of that student's sessions and never in another student's", async () => {
		const h = await classroom();
		h.signIn("bob");
		expect((await complete(h)).status).toBe(200);
		h.signIn("alice");
		h.decisions.set("alice", { warning: true, blocked: false });
		expect((await complete(h)).status).toBe(200);
		for (const agent of [undefined, "agent-a", "agent-a2"]) expect(lane(await h.snapshot(agent), "tutoring")).toBe("low");
		h.signIn("bob");
		for (const agent of [undefined, "agent-a", "agent-a2"]) expect(lane(await h.snapshot(agent), "tutoring")).toBe("available");

		h.signIn("alice");
		h.decisions.set("alice", { warning: true, blocked: true });
		expect((await complete(h)).status).toBe(403);
		for (const agent of [undefined, "agent-a", "agent-a2"]) {
			const snapshot = await h.snapshot(agent);
			expect(lane(snapshot, "autocomplete")).toBe("exhausted");
			for (const name of ["open-editor", "use-terminal", "run-tests"]) expect(action(snapshot, name)?.available).toBe(true);
		}
		h.signIn("bob");
		const bob = await h.snapshot("agent-a");
		expect(lane(bob, "autocomplete")).toBe("available");
		expect(action(bob, "autocomplete")?.available).toBe(true);
		// Admission is per student: each gets its own GUI admission session.
		const sessions = (user: string) => new Set(h.admissions.filter(item => item.userId === user).map(item => item.sessionId));
		expect(sessions("alice").size).toBe(1);
		expect([...sessions("alice")][0]).not.toBe([...sessions("bob")][0]);
	});

	it("keeps session limits to their own Chat session", async () => {
		const h = await classroom();
		h.signIn("alice");
		await h.publish("alice", "session-a", { type: "budget.exhausted", reason: "The AI implementation budget has been reached.", lane: "agent" });
		await h.publish("alice", "session-a", { type: "model.health", available: false });
		const one = await h.snapshot("agent-a");
		expect(lane(one, "agent")).toBe("exhausted");
		expect(one.model.available).toBe(false);
		for (const agent of [undefined, "agent-a2"]) {
			const other = await h.snapshot(agent);
			expect(lane(other, "agent")).toBe("available");
			expect(other.model.available).toBe(true);
			expect(action(other, "agent-edit")?.available).toBe(true);
		}
		// An institutional limit still reaches every session, including the one with its own session limit.
		await h.publish("alice", "session-a", { type: "model.health", available: true });
		h.decisions.set("alice", { warning: false, blocked: false, agentBlocked: true });
		await complete(h);
		for (const agent of [undefined, "agent-a", "agent-a2"]) expect(action(await h.snapshot(agent), "agent-edit")).toMatchObject({ available: false, reason: "agent_budget_exhausted" });
		h.signIn("bob");
		expect(action(await h.snapshot("agent-a"), "agent-edit")?.available).toBe(true);
	});

	it("keys admission signals by the same student-project identity as workspace state", async () => {
		const h = await classroom();
		expect(workspaceEventKey({ projectPath: h.project, projectId: "project-a", organizationId: "school", userId: "alice" }))
			.not.toBe(workspaceEventKey({ projectPath: h.project, projectId: "project-a", organizationId: "school" }));
		h.signIn("alice");
		h.decisions.set("alice", { warning: true, blocked: false });
		await complete(h);
		// Identity lookup fails: the snapshot carries no presentation state at all, Alice's included.
		h.signIn(new Error("down"));
		const unavailable = await h.snapshot("agent-a");
		expect(unavailable.scope.identityRequired).toBe(true);
		expect(lane(unavailable, "tutoring")).not.toBe("low");
	});
});
