import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CAPABILITY_POLICY, allowedReasoningLevels, modelAllowed, parseCapabilityPolicy } from "@pi-student/policy/capability-policy";
import { CapabilityState, guardCapabilitySession } from "@pi-student/policy/capability-runtime";
import { createProjectCapabilitiesExtension } from "@pi-student/runtime/project-capabilities";
import { DictationController } from "@pi-student/runtime/dictation";
import { SessionRecorder } from "@pi-student/telemetry/session-recorder";
import { LearningEventBus } from "@pi-student/telemetry/events";

const policy = () => structuredClone(DEFAULT_CAPABILITY_POLICY);
const model = { provider: "test", id: "a", reasoning: true };
function state() { const result = new CapabilityState(); result.select({ projectId: "p", version: 2, settings: policy() }); return result; }
function extension(controls = state()) {
	const handlers = new Map<string, Function>();
	const pi = { on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: vi.fn() };
	const sandbox = { setInternetAllowed: vi.fn() };
	const ctx = { cwd: "/workspace", abort: vi.fn(), ui: { notify: vi.fn() } };
	createProjectCapabilitiesExtension(controls, sandbox as never)(pi as never);
	return { controls, sandbox, ctx, call: (name: string, event: unknown) => handlers.get(name)!(event, ctx) };
}
describe("project capability controls", () => {
	it("preserves defaults without sharing mutable arrays", () => { const p = parseCapabilityPolicy(null); p.reasoningLevels.length = 0; expect(policy().reasoningLevels.length).toBe(7); });
	it("supports non-contiguous teacher-selected reasoning levels", () => { const p = policy(); p.reasoningLevels = ["low", "high", "max"]; expect(allowedReasoningLevels(p, model)).toEqual(["low", "high"]); });
	it("does not substitute off when the teacher disabled it", () => { const p = policy(); p.reasoningLevels = ["high"]; expect(modelAllowed(p, { ...model, reasoning: false })).toBe(false); });
	it.each([{ levels: [] }, { levels: ["ultra"] }, { levels: ["bogus"] }])("rejects invalid reasoning choices $levels", ({ levels }) => { expect(() => parseCapabilityPolicy({ ...policy(), reasoningLevels: levels })).toThrow(); });
	it("rejects invalid budget values", () => { expect(() => parseCapabilityPolicy({ ...policy(), limits: { ...policy().limits, turns: -2 } })).toThrow(); });
	it("keeps accommodations independent of editing permissions", () => { const p = policy(); p.fileEditing = false; p.accessibility.dictation = true; expect(parseCapabilityPolicy(p).fileEditing).toBe(false); });
	it("starts a new independent policy snapshot when the project changes", () => { const s = state(); s.block("terminal"); s.turns = 10; s.select({ projectId: "other", version: 1, settings: policy() }); expect(s.blocked).toEqual({}); expect(s.turns).toBe(0); expect(s.effective?.projectId).toBe("other"); });
	it("enforces reasoning and model choices at the session boundary", async () => {
		const s = state(); s.settings.reasoningLevels = ["low", "high"]; s.settings.models = ["test/a"];
		const session = { model, thinkingLevel: "medium", getAvailableThinkingLevels: () => ["off", "low", "medium", "high"], setThinkingLevel: vi.fn(function(this: any, level: string) { this.thinkingLevel = level; }), setModel: vi.fn(), prompt: vi.fn() };
		guardCapabilitySession(session as never, s);
		expect(session.getAvailableThinkingLevels()).toEqual(["low", "high"]);
		expect(() => session.setThinkingLevel("medium")).toThrow();
		await expect(session.setModel({ ...model, id: "b" })).rejects.toThrow();
		await session.prompt("hello"); expect(session.thinkingLevel).toBe("low");
	});
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
	it("stops an automatic run after reaching its response budget", async () => { const h = extension(); h.controls.settings.limits.turns = 1; await h.call("message_end", { message: { role: "assistant", content: [], usage: { totalTokens: 3, cost: { total: 0 } } } }); expect(h.ctx.abort).toHaveBeenCalled(); expect(h.controls.limitReached()).toContain("response limit"); });
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
