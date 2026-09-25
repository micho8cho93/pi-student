import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecutionContext, NextAvailableAction, StudentAction, WorkspaceUiState } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { CapabilityState, guardCapabilitySession } from "@pi-student/policy/capability-runtime";
import { describeAssistanceFallback, formatAssistanceFallback, resolveNextAvailableActions } from "../src/assistance.js";
import { resolveExecutionContext } from "../src/execution-context.js";
import { resolveStudentCapabilities, unavailableStudentCapabilities, type StudentCapabilityInputs } from "../src/student-workspace.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function context(settings: Partial<typeof DEFAULT_CAPABILITY_POLICY> = {}, sandbox: { internetAllowed?: boolean } = {}): Promise<ExecutionContext> {
	const workspacePath = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-assist-")));
	roots.push(workspacePath);
	const policy = { projectId: "project-a", version: 1, sourceVersions: { organization: 1 },
		settings: { ...DEFAULT_CAPABILITY_POLICY, models: ["openai/small"], reasoningLevels: ["off", "low", "medium", "high"] as typeof DEFAULT_CAPABILITY_POLICY.reasoningLevels,
			terminal: true, fileEditing: true, dependencyInstallation: true, internet: true, ...settings } };
	const resolved = await resolveExecutionContext({ workspacePath, sessionId: "s",
		selection: { workspacePath, projectId: "project-a", classId: "class-a", organizationId: "org-a" },
		identityProvider: { getIdentity: async () => ({ kind: "student" as const, userId: "student-a" }) },
		scopeProvider: { resolve: vi.fn(async () => ({ projectId: "project-a", classId: "class-a", organizationId: "org-a", userId: "student-a" })) },
		policyProvider: { resolvePolicy: vi.fn(async () => policy) },
		environmentProvider: { resolve: vi.fn(async () => ({ sandbox: { mode: "gondolin" as const }, skills: [], mcps: [] })) } });
	return { ...resolved, sandbox: { ...resolved.sandbox, ...sandbox } };
}

const generatedMap: WorkspaceUiState = { openFiles: [], recentChanges: [], flowchart: { generatedAt: "2026-09-25T10:00:00.000Z", stale: false } };

async function actions(settings: Partial<typeof DEFAULT_CAPABILITY_POLICY> = {}, inputs: StudentCapabilityInputs = {}, sandbox?: { internetAllowed?: boolean }) {
	const capabilities = resolveStudentCapabilities(await context(settings, sandbox), inputs);
	return resolveNextAvailableActions({ capabilities, ui: generatedMap });
}

const status = (list: NextAvailableAction[]) => Object.fromEntries(list.map(item => [item.action, item.available ? true : item.reason])) as Record<StudentAction, true | string>;
/** Manual work never depends on AI, policy for the agent, or the sandbox. */
const MANUAL: StudentAction[] = ["open-editor", "use-terminal", "run-tests", "view-map"];
const expectAvailable = (list: NextAvailableAction[], expected: StudentAction[]) => {
	const current = status(list);
	for (const action of expected) expect(current[action], action).toBe(true);
};

describe("assistance ladder", () => {
	it("everything is available with a capable model and permissive policy", async () => {
		const list = await actions();
		expect(Object.values(status(list)).filter(value => value !== true)).toEqual(["no_extensions"]);
		expect(list.some(item => item.recommended)).toBe(false);
		expect(describeAssistanceFallback(list)).toBeUndefined();
	});

	it("token exhaustion stops AI help but keeps manual work and the existing map", async () => {
		const usage = new CapabilityState();
		usage.select((await context({ limits: { minutes: null, turns: null, tokens: 100, cost: null } })).policy);
		usage.tokens = 100;
		const list = await actions({ limits: { minutes: null, turns: null, tokens: 100, cost: null } }, { usage });
		const current = status(list);
		for (const action of ["agent-edit", "ask-guidance", "autocomplete", "generate-map", "learn-mode"] as const) expect(current[action]).toBe("budget_exhausted");
		expectAvailable(list, MANUAL);
		expect(list.filter(item => item.recommended).map(item => item.action)).toEqual(["open-editor", "use-terminal", "run-tests", "view-map"].sort((a, b) =>
			list.findIndex(item => item.action === a) - list.findIndex(item => item.action === b)));
		const message = formatAssistanceFallback(list, "The project session token limit has been reached.")!;
		expect(message).toMatch(/^AI help is paused/);
		expect(message).toContain("You can still:\n- inspect the architecture in the flowchart\n- edit the code yourself\n- run tests\n- use the terminal");
		expect(message).not.toMatch(/Token limit reached\.$/);
	});

	it("an exhausted organization budget reported outside the session has the same effect", async () => {
		const list = await actions({}, { exhausted: "The organization AI budget or token limit has been reached." });
		expect(status(list)["ask-guidance"]).toBe("budget_exhausted");
		expectAvailable(list, MANUAL);
	});

	it("a reasoning restriction only removes long reasoning", async () => {
		const list = await actions({ reasoningLevels: ["off", "low"] });
		expect(status(list)["deep-reasoning"]).toBe("reasoning_restricted");
		expectAvailable(list, ["agent-edit", "agent-run-command", "ask-guidance", "autocomplete", "generate-map", ...MANUAL]);
		expect(describeAssistanceFallback(list)).toBeUndefined();
	});

	it("a model without reliable tool use keeps conversation and guides manual editing", async () => {
		const list = await actions({}, { model: { toolUse: false } });
		const current = status(list);
		for (const action of ["agent-edit", "agent-run-command", "agent-install-dependencies"] as const) expect(current[action]).toBe("model_cannot_use_tools");
		expectAvailable(list, ["ask-guidance", "ask-explanation", "learn-mode", "autocomplete", "generate-map", ...MANUAL]);
		expect(formatAssistanceFallback(list)).toBe([
			"This model can continue helping you reason about the problem, but reliable file editing is unavailable.",
			"Open the relevant file and continue manually.",
			"You can still:\n- ask for guidance\n- inspect the architecture in the flowchart\n- edit the code yourself\n- use autocomplete\n- run tests\n- use the terminal",
		].join("\n\n"));
	});

	it("a provider outage removes every AI surface, not code, the existing map, or the terminal", async () => {
		const list = await actions({}, { model: { available: false } });
		const current = status(list);
		for (const action of ["agent-edit", "ask-guidance", "ask-explanation", "autocomplete", "generate-map", "learn-mode", "deep-reasoning"] as const) {
			expect(current[action]).toBe("provider_unavailable");
		}
		expectAvailable(list, MANUAL);
		// Without a generated map, generating one is not offered either.
		const noMap = resolveNextAvailableActions({ capabilities: resolveStudentCapabilities(await context(), { model: { available: false } }), ui: { openFiles: [], recentChanges: [] } });
		expect(status(noMap)["view-map"]).toBe("no_flowchart");
		expect(describeAssistanceFallback(noMap)?.canStill).toEqual(["edit the code yourself", "run tests", "use the terminal"]);
		// When project controls cannot be resolved at all, the same manual paths remain.
		expectAvailable(resolveNextAvailableActions({ capabilities: unavailableStudentCapabilities("Offline"), ui: generatedMap }), MANUAL);
	});

	it("disabling agent editing keeps guidance, autocomplete is policy-linked, and manual editing stays", async () => {
		const list = await actions({ fileEditing: false });
		const current = status(list);
		expect(current["agent-edit"]).toBe("agent_editing_disabled");
		expect(current.autocomplete).toBe("autocomplete_disabled");
		expectAvailable(list, ["ask-guidance", "ask-explanation", "agent-run-command", "generate-map", ...MANUAL]);
		expect(list.find(item => item.action === "ask-guidance")?.recommended).toBe(true);
		const message = formatAssistanceFallback(list)!;
		expect(message).toContain("Agent editing is unavailable for this project.");
		expect(message).toContain("- ask for guidance");
		expect(message).not.toContain("- use autocomplete");
	});

	it("autocomplete being unavailable leaves the editor and every other surface usable", async () => {
		const capabilities = resolveStudentCapabilities(await context());
		const list = resolveNextAvailableActions({ capabilities: { ...capabilities, autocomplete: { allowed: false, reason: "Limit", code: "autocomplete_disabled" } }, ui: generatedMap });
		expect(status(list).autocomplete).toBe("autocomplete_disabled");
		expectAvailable(list, ["agent-edit", "ask-guidance", "generate-map", ...MANUAL]);
		expect(describeAssistanceFallback(list)).toBeUndefined();
	});

	it("an unavailable sandbox stops agent execution but not conversation or the student's own tools", async () => {
		const list = await actions({}, { sandbox: { running: false } });
		const current = status(list);
		for (const action of ["agent-edit", "agent-run-command", "agent-install-dependencies"] as const) expect(current[action]).toBe("sandbox_unavailable");
		expectAvailable(list, ["ask-guidance", "autocomplete", "generate-map", ...MANUAL]);
		expect(formatAssistanceFallback(list)).toMatch(/^Agent editing is unavailable because the AI's workspace is not running\./);
	});

	it("disabling the internet affects only internet access", async () => {
		for (const list of [await actions({ internet: false }), await actions({}, {}, { internetAllowed: false })]) {
			expect(status(list)["use-internet"]).toBe("internet_disabled");
			expectAvailable(list, ["agent-edit", "agent-run-command", "agent-install-dependencies", "ask-guidance", "autocomplete", "generate-map", ...MANUAL]);
		}
	});

	it("is deterministic and independent of anything the model says", async () => {
		const capabilities = resolveStudentCapabilities(await context(), { model: { toolUse: false } });
		expect(resolveNextAvailableActions({ capabilities, ui: generatedMap })).toEqual(resolveNextAvailableActions({ capabilities, ui: generatedMap }));
	});
});

describe("agent budget exhausted", () => {
	it("moves from AI doing to AI assisting instead of stopping everything", async () => {
		const list = await actions({}, { agentExhausted: "The AI implementation budget has been reached." });
		const current = status(list);
		for (const action of ["agent-edit", "agent-run-command", "agent-install-dependencies"] as const) expect(current[action]).toBe("agent_budget_exhausted");
		expectAvailable(list, ["ask-guidance", "ask-explanation", "learn-mode", "autocomplete", "generate-map", ...MANUAL]);
		expect(list.find(item => item.action === "ask-guidance")?.recommended).toBe(true);
		const fallback = describeAssistanceFallback(list);
		expect(fallback?.headline).toContain("AI tutoring is still available");
		expect(fallback?.canStill).toContain("ask for guidance");
	});
});

describe("session limit messages", () => {
	it("explain what still works instead of only reporting the limit", async () => {
		const state = new CapabilityState();
		state.select({ projectId: "p", version: 1, sourceVersions: {}, settings: { ...DEFAULT_CAPABILITY_POLICY, limits: { ...DEFAULT_CAPABILITY_POLICY.limits, tokens: 10 } } });
		state.tokens = 10;
		const session = { prompt: vi.fn(), setModel: vi.fn(), setThinkingLevel: vi.fn(), getAvailableThinkingLevels: () => [], model: undefined, thinkingLevel: "off" };
		guardCapabilitySession(session as never, state, undefined, async reason => `${reason}\n\nYou can still:\n- edit the code yourself`);
		await expect(session.prompt("hi")).rejects.toThrow("The project session token limit has been reached.\n\nYou can still:\n- edit the code yourself");
		expect(session.prompt).not.toBe(vi.fn());
		const plain = { ...session, prompt: vi.fn() };
		guardCapabilitySession(plain as never, state);
		await expect(plain.prompt("hi")).rejects.toThrow(/^The project session token limit has been reached\.$/);
	});

	it("do not stop the conversation when only the agent limit is reached", async () => {
		const state = new CapabilityState();
		state.select({ projectId: "p", version: 1, sourceVersions: {}, settings: { ...DEFAULT_CAPABILITY_POLICY, limits: { ...DEFAULT_CAPABILITY_POLICY.limits, turns: 1 } } });
		state.turns = 1;
		const session = { prompt: vi.fn(async () => {}), setModel: vi.fn(), setThinkingLevel: vi.fn(), getAvailableThinkingLevels: () => [], model: undefined, thinkingLevel: "off" };
		guardCapabilitySession(session as never, state);
		await expect(session.prompt("How should I start?")).resolves.toBeUndefined();
		expect(state.tutoringOnly()).toBe(true);
	});
});
