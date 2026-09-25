import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionContext } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { CapabilityState } from "@pi-student/policy/capability-runtime";
import { resolveExecutionContext } from "../src/execution-context.js";
import { createStudentWorkspace, resolveStudentCapabilities, updateWorkspaceUi } from "../src/student-workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function workspace(prefix = "pi-workspace-") {
	const root = await mkdtemp(path.join(os.tmpdir(), prefix));
	roots.push(root);
	return realpath(root);
}

async function managedContext(settings: Partial<typeof DEFAULT_CAPABILITY_POLICY> = {}, workspacePath?: string): Promise<ExecutionContext> {
	workspacePath ??= await workspace();
	const policy = { projectId: "project-a", version: 1, sourceVersions: { organization: 1 },
		settings: { ...DEFAULT_CAPABILITY_POLICY, models: ["openai/small"], ...settings } };
	return resolveExecutionContext({ workspacePath, sessionId: "session-a",
		selection: { workspacePath, projectId: "project-a", classId: "class-a", organizationId: "org-a" },
		identityProvider: { getIdentity: async () => ({ kind: "student" as const, userId: "student-a" }) },
		scopeProvider: { resolve: vi.fn(async () => ({ projectId: "project-a", classId: "class-a", organizationId: "org-a", userId: "student-a" })) },
		policyProvider: { resolvePolicy: vi.fn(async () => policy) },
		environmentProvider: { resolve: vi.fn(async () => ({ sandbox: { mode: "gondolin" as const }, skills: [], mcps: [] })) } });
}

async function personalContext(): Promise<ExecutionContext> {
	const workspacePath = await workspace();
	return resolveExecutionContext({ workspacePath, selection: {},
		identityProvider: { getIdentity: async () => ({ kind: "student" as const }) },
		policyProvider: { resolvePolicy: vi.fn(async () => undefined) } });
}

describe("student workspace binding", () => {
	it("cannot bind project A to workspace B", async () => {
		const context = await managedContext();
		const other = await workspace("pi-other-");
		const capabilities = resolveStudentCapabilities(context);
		expect(() => createStudentWorkspace(context, { capabilities, claimed: { projectPath: other } })).toThrow("projectPath");
		expect(() => createStudentWorkspace(context, { capabilities, claimed: { projectId: "project-b" } })).toThrow("projectId");
		expect(() => createStudentWorkspace(context, { capabilities, claimed: { organizationId: "org-b" } })).toThrow("organizationId");
		const otherContext = await managedContext({}, other);
		const personal = resolveStudentCapabilities(await personalContext());
		expect(() => createStudentWorkspace(otherContext, { capabilities: personal })).toThrow("another project");
		expect(() => createStudentWorkspace(context, { capabilities, ui: { openFiles: [path.join(other, "secret.ts")] } })).toThrow("outside the project");
		expect(createStudentWorkspace(context, { capabilities, claimed: { projectPath: context.workspacePath, projectId: "project-a" } }).scope)
			.toMatchObject({ projectPath: context.workspacePath, projectId: "project-a", classId: "class-a", organizationId: "org-a", userId: "student-a", sessionId: "session-a" });
	});

	it("transient editor state cannot override authoritative project identity", async () => {
		const context = await managedContext();
		const state = createStudentWorkspace(context, { capabilities: resolveStudentCapabilities(context), ui: { activeFile: "src/a.ts" } });
		expect(() => updateWorkspaceUi(state, { projectId: "project-b" } as never)).toThrow("cannot change projectId");
		expect(() => updateWorkspaceUi(state, { capabilities: {} } as never)).toThrow("cannot change capabilities");
		expect(() => updateWorkspaceUi(state, { activeFile: "../other-project/index.ts" })).toThrow("outside the project");
		expect(() => { (state.scope as { projectId?: string }).projectId = "project-b"; }).toThrow();
		const next = updateWorkspaceUi(state, { activeFile: `${context.workspacePath}/src/b.ts`, openFiles: ["src/a.ts", "./src/a.ts", "src/b.ts"] });
		expect(next.scope).toBe(state.scope);
		expect(next.capabilities).toBe(state.capabilities);
		expect(next.ui).toMatchObject({ activeFile: "src/b.ts", openFiles: ["src/a.ts", "src/b.ts"] });
	});

	it("missing optional state does not prevent basic workspace usage", async () => {
		const context = await personalContext();
		const state = createStudentWorkspace(context, { capabilities: resolveStudentCapabilities(context) });
		expect(state.learning).toEqual({ stage: "understand", learnMode: false });
		expect(state.ui).toEqual({ openFiles: [], recentChanges: [] });
		expect(state.model).toBeUndefined();
		expect(state.capabilities.chat.allowed).toBe(true);
		expect(updateWorkspaceUi(state, { terminal: { lastCommand: "npm test", lastExitCode: 0 } }).ui.terminal?.lastExitCode).toBe(0);
	});
});

describe("effective student capabilities", () => {
	it("matches the execution context and its policy", async () => {
		const context = await managedContext({ reasoningLevels: ["low", "medium"] });
		const capabilities = resolveStudentCapabilities(context, { models: ["openai/small"] });
		expect(capabilities).toMatchObject({ projectId: context.projectId, organizationId: context.organizationId,
			chat: { allowed: true }, agentFileEditing: { allowed: true }, autocomplete: { allowed: true },
			terminal: { allowed: true, inspectionOnly: false }, internet: { allowed: true }, dependencyInstallation: { allowed: true },
			learn: { allowed: true }, models: ["openai/small"], reasoningLevels: ["low", "medium"],
			architecture: { allowed: true },
			budget: { overall: { status: "available" }, agent: { status: "available" }, tutoring: { status: "available" },
				session: { remaining: { turns: null, tokens: null, cost: null, minutes: null, tutoringTurns: null } } } });
		expect(() => createStudentWorkspace(context, { capabilities, model: "openai/large" })).toThrow("not available");
		expect(createStudentWorkspace(context, { capabilities, model: "openai/small" }).model).toBe("openai/small");
	});

	it("propagates organization restrictions", async () => {
		const restricted = resolveStudentCapabilities(await managedContext({ fileEditing: false, dependencyInstallation: true, internet: false }));
		expect(restricted.agentFileEditing).toEqual({ allowed: false, reason: "File editing is disabled for this project.", code: "agent_editing_disabled" });
		expect(restricted.autocomplete.allowed).toBe(false);
		expect(restricted.terminal).toMatchObject({ allowed: true, inspectionOnly: true });
		expect(restricted.dependencyInstallation.allowed).toBe(false);
		expect(restricted.internet.allowed).toBe(false);
		expect(restricted.extensions).toMatchObject({ allowed: false, skills: [], mcps: [] });

		const noModels = resolveStudentCapabilities(await managedContext({ models: [] }));
		for (const surface of [noModels.chat, noModels.agentFileEditing, noModels.autocomplete, noModels.terminal, noModels.learn]) {
			expect(surface).toMatchObject({ allowed: false, reason: "No model is approved for this project." });
		}
		const unavailable = resolveStudentCapabilities(await managedContext(), { models: [] });
		expect(unavailable.chat.reason).toContain("institution-approved");
	});

	it("keeps tutoring after agent execution is exhausted, then stops at cost limits", async () => {
		const context = await managedContext({ limits: { minutes: null, turns: 3, tokens: 1000, cost: null, tutoringTurns: 2 } });
		const usage = new CapabilityState();
		usage.select(context.policy);
		usage.turns = 1; usage.tokens = 400;
		expect(resolveStudentCapabilities(context, { usage }).budget.session.remaining).toMatchObject({ turns: 2, tokens: 600, cost: null, tutoringTurns: 2 });

		// AI doing -> AI assisting: the agent stops, tutoring and autocomplete continue.
		usage.turns = 3;
		const tutoring = resolveStudentCapabilities(context, { usage });
		expect(tutoring.budget).toMatchObject({ agent: { status: "exhausted", reason: expect.stringContaining("response limit") },
			tutoring: { status: "available" }, autocomplete: { status: "available" }, architecture: { status: "available" }, overall: { status: "available" } });
		expect(tutoring.agentFileEditing).toMatchObject({ allowed: false, code: "agent_budget_exhausted" });
		expect(tutoring.terminal.code).toBe("agent_budget_exhausted");
		for (const surface of [tutoring.chat, tutoring.learn, tutoring.autocomplete, tutoring.architecture]) expect(surface.allowed).toBe(true);

		// AI assisting -> student doing: the tutoring reserve is used, autocomplete remains.
		usage.tutoringTurns = 2;
		const reserveUsed = resolveStudentCapabilities(context, { usage });
		expect(reserveUsed.budget.tutoring).toMatchObject({ status: "exhausted", reason: expect.stringContaining("tutoring allowance") });
		expect(reserveUsed.chat).toMatchObject({ allowed: false, code: "budget_exhausted" });
		expect(reserveUsed.autocomplete.allowed).toBe(true);

		// Cost limits stop all AI.
		usage.tokens = 1000;
		const exhausted = resolveStudentCapabilities(context, { usage });
		for (const lane of ["overall", "agent", "tutoring", "autocomplete", "architecture"] as const) expect(exhausted.budget[lane].status).toBe("exhausted");
		expect(exhausted.autocomplete.allowed).toBe(false);
	});

	it("maps an organization agent-only budget block onto the agent lane", async () => {
		const context = await managedContext();
		const capabilities = resolveStudentCapabilities(context, { agentExhausted: "The AI implementation budget has been reached.", warning: "Usage is high." });
		expect(capabilities.budget).toMatchObject({ agent: { status: "exhausted" }, tutoring: { status: "low" }, overall: { status: "low" } });
		expect(capabilities.chat.allowed).toBe(true);
		expect(capabilities.agentFileEditing.code).toBe("agent_budget_exhausted");
		const blocked = resolveStudentCapabilities(context, { exhausted: "The AI budget has been reached." });
		expect(blocked.chat.code).toBe("budget_exhausted");
		expect(blocked.autocomplete.code).toBe("budget_exhausted");
	});

	it("personal projects still work", async () => {
		const context = await personalContext();
		const capabilities = resolveStudentCapabilities(context, { models: ["ollama/llama3"] });
		expect(capabilities).toMatchObject({ projectId: undefined, organizationId: undefined, chat: { allowed: true },
			agentFileEditing: { allowed: true }, terminal: { allowed: true, inspectionOnly: false }, models: ["ollama/llama3"] });
		expect(capabilities.extensions.allowed).toBe(false);
		const state = createStudentWorkspace(context, { capabilities, model: "ollama/llama3", learning: { stage: "plan", learnMode: true } });
		expect(state.scope).toMatchObject({ projectPath: context.workspacePath, projectId: undefined });
		expect(state.learning).toEqual({ stage: "plan", learnMode: true });
	});
});
