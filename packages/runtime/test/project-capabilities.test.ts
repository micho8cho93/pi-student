import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { CapabilityState } from "@pi-student/policy/capability-runtime";
import { createProjectCapabilitiesExtension } from "@pi-student/runtime/project-capabilities";
import { DictationController } from "@pi-student/runtime/dictation";
import { SessionRecorder } from "@pi-student/telemetry/session-recorder";
import { LearningEventBus } from "@pi-student/telemetry/events";

const policy = () => structuredClone(DEFAULT_CAPABILITY_POLICY);
function state() { const result = new CapabilityState(); result.select({ projectId: "p", version: 2, settings: policy() }); return result; }
function extension(controls = state()) {
	const handlers = new Map<string, Function>();
	let active = ["read", "edit"];
	const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: vi.fn(),
		getActiveTools: vi.fn(() => active), setActiveTools: vi.fn((tools: string[]) => { active = tools; }) };
	const sandbox = { setInternetAllowed: vi.fn() };
	const ctx = { cwd: "/workspace", abort: vi.fn(), ui: { notify: vi.fn() } };
	createProjectCapabilitiesExtension(controls, sandbox as never)(pi as never);
	return { controls, sandbox, ctx, pi, call: (name: string, event: unknown) => handlers.get(name)!(event, ctx) };
}
describe("project capability controls", () => {
	it.each(["fileEditing", "terminal", "desktopExport"] as const)("blocks disabled %s", async key => {
		const h = extension(); h.controls.settings[key] = false;
		const toolName = key === "fileEditing" ? "write" : key === "terminal" ? "bash" : "save_to_desktop";
		expect(await h.call("tool_call", { toolName, input: { command: "ls" } })).toMatchObject({ block: true });
		expect(h.controls.blocked[key]).toBe(1);
	});
	it("blocks indirect shell edits and installs", async () => { const h = extension(); h.controls.settings.dependencyInstallation = false; expect(await h.call("tool_call", { toolName: "bash", input: { command: "node installer.js" } })).toMatchObject({ block: true }); expect(await h.call("tool_call", { toolName: "bash", input: { command: "ls" } })).toBeUndefined(); });
	it("applies network controls before the turn", async () => { const h = extension(); h.controls.settings.internet = false; await h.call("before_agent_start", { systemPrompt: "base" }); expect(h.sandbox.setInternetAllowed).toHaveBeenCalledWith(false); });
	it("blocks Paseo uploaded-file and fallback-image payloads", async () => {
		const h = extension(); h.controls.settings.fileUploads = false; h.controls.settings.imageUploads = false;
		expect(await h.call("input", { text: "Review this\n\nUploaded file: a.txt\nPath: /tmp/a.txt\nMIME: text/plain\nSize: 10 bytes" })).toEqual({ action: "handled" });
		expect(await h.call("input", { text: "[Image available at: /tmp/a.png]" })).toEqual({ action: "handled" });
		expect(await h.call("input", { text: "Explain files" })).toBeUndefined();
	});
	it("stops an automatic run after reaching its response budget", async () => { const h = extension(); h.controls.settings.limits.turns = 1; await h.call("message_end", { message: { role: "assistant", content: [], usage: { totalTokens: 3, cost: { total: 0 } } } }); expect(h.ctx.abort).toHaveBeenCalled(); expect(h.controls.agentLimitReached()).toContain("response limit"); expect(h.controls.limitReached()).toBeUndefined(); });
	it("switches to tool-free tutoring after the agent limit and stops at the tutoring reserve", async () => {
		const h = extension(); h.controls.settings.limits.turns = 1; h.controls.settings.limits.tutoringTurns = 1; h.controls.turns = 1;
		const started = await h.call("before_agent_start", { systemPrompt: "base" });
		expect(h.pi.setActiveTools).toHaveBeenCalledWith([]);
		expect(started.systemPrompt).toContain("Tutoring mode");
		expect(await h.call("tool_call", { toolName: "read", input: { path: "a.ts" } })).toMatchObject({ block: true, reason: expect.stringContaining("Guide the student") });
		expect(h.controls.blocked.agentLimits).toBe(1);
		expect(await h.call("input", { text: "Why does this fail?" })).toBeUndefined();
		await h.call("message_end", { message: { role: "assistant", content: [], usage: { totalTokens: 3, cost: { total: 0 } } } });
		expect(h.controls).toMatchObject({ turns: 1, tutoringTurns: 1 });
		expect(h.controls.limitReached()).toContain("tutoring allowance");
		expect(await h.call("input", { text: "One more hint" })).toEqual({ action: "handled" });
	});
	it("restores the agent's tools when agent execution becomes available again", async () => {
		const h = extension(); h.controls.agentBlocked = "The organization's AI implementation budget has been reached.";
		await h.call("before_agent_start", { systemPrompt: "base" });
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith([]);
		h.controls.agentBlocked = undefined;
		const started = await h.call("before_agent_start", { systemPrompt: "base" });
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "edit"]);
		expect(started.systemPrompt).not.toContain("Tutoring mode");
	});
	it("blocks remote dictation before recording or requesting consent", async () => {
		const dictation = new DictationController(); vi.spyOn(dictation, "getBackend").mockResolvedValue({ kind: "openai", label: "test", endpoint: "https://example.com", model: "test", apiKey: "test", remote: true });
		const confirmRemote = vi.fn(); await expect(dictation.start({ allowRemote: false, confirmRemote })).rejects.toThrow("on-device"); expect(confirmRemote).not.toHaveBeenCalled();
	});
	it("records an immutable policy copy without transcript content", () => {
		const bus = new LearningEventBus(); const recorder = new SessionRecorder(bus); const s = state();
		bus.emit({ type: "SESSION_STARTED", sessionId: "session", context: { projectId: "p", policy: s.effective } });
		s.settings.fileEditing = false;
		expect(recorder.getRecord()?.policy?.settings.fileEditing).toBe(true);
		expect(recorder.getRecord()?.policy?.version).toBe(2); recorder.dispose();
	});
});
