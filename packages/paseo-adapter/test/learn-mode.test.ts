import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodebaseModel, relationshipDiagram } from "@pi-student/education/project-model";
import { LearnSettingsStore } from "@pi-student/education/settings";
import { CURRENT_WORK_TOPIC, parseQuestion, registerLearnMode, LEARN_GUIDANCE } from "@pi-student/education/extension";
import { resolveLearnSession } from "@pi-student/paseo-adapter/paseo-session";
import { HostRuntime } from "@pi-student/sandbox-gondolin/host-runtime";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { createLearningSession } from "@pi-student/education/types";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function directory() { const p = await mkdtemp(path.join(os.tmpdir(), "pi-learn-")); temporary.push(p); return p; }
async function fixture(files: Record<string, string>) {
	const root = await directory();
	for (const [name, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
	const runtime = new HostRuntime(); await runtime.start(root);
	return { root, runtime, codebase: new CodebaseModel(runtime) };
}

describe("shared codebase model", () => {
	it.each([
		[{ "main.py": "print('hi')", "requirements.txt": "flask==3.0" }, "Python", "flask"],
		[{ "package.json": '{"dependencies":{"react":"19","vite":"6"}}', "src/App.tsx": "export function App() {}" }, "TypeScript", "react"],
		[{ "apps/web/package.json": '{"dependencies":{"react":"19"}}', "apps/server/package.json": '{"dependencies":{"express":"5"}}', "apps/server/index.js": "" }, "JavaScript", "express"],
	] as const)("detects evidence from representative repositories", async (files, language, technology) => {
		const { codebase } = await fixture(files);
		const model = await codebase.get();
		expect(model.languages).toContain(language);
		expect(model.technologies).toEqual(expect.arrayContaining([expect.objectContaining({ name: technology, evidence: expect.objectContaining({ confidence: "confirmed" }) })]));
	});
	it("handles incomplete repositories without invented technologies", async () => {
		const { codebase } = await fixture({ "package.json": "{oops", "notes.txt": "unusual" });
		const model = await codebase.get();
		expect(model.technologies).toEqual([]);
		expect(model.coverage.errors).toContain("Cannot parse package.json");
	});
	it("scans lazily, caches, inspects relationships, refreshes changed source, and excludes dependencies", async () => {
		const { root, runtime, codebase } = await fixture({ "package.json": '{"scripts":{"dev":"node src/main.js"}}', "src/main.js": 'import { login } from "./auth.js";\nfunction start() {}\napp.post("/login", login);', "src/auth.js": "export function login() {}", "node_modules/hidden.js": "", ".env": "secret" });
		const read = vi.spyOn(runtime, "readFile");
		const initial = await codebase.get();
		expect(read.mock.calls.map(c => c[0])).toEqual(["/workspace/package.json"]);
		expect(await codebase.get()).toBe(initial);
		expect(await codebase.search("auth")).toEqual(["src/auth.js"]);
		await codebase.inspect("src/main.js");
		expect(relationshipDiagram(await codebase.get())).toContain('imports → ./auth.js');
		expect(initial.sources[0].routes).toEqual(["/login:3"]);
		await writeFile(path.join(root, "src/main.js"), 'import "./other.js";');
		await codebase.inspect("src/main.js");
		expect(initial.relationships.some(r => r.to === "./auth.js")).toBe(false);
		expect(initial.relationships.some(r => r.to === "./other.js")).toBe(true);
		await expect(codebase.inspect("../secret.ts")).rejects.toThrow("outside");
		await expect(codebase.inspect(".env")).rejects.toThrow("source file");
		await expect(codebase.inspect("node_modules/hidden.js")).rejects.toThrow("excluded");
		await codebase.get(true);
		expect(read.mock.calls.filter(c => c[0].endsWith("package.json"))).toHaveLength(2);
	});
	it("traces local imports across cycles without claiming runtime order", async () => {
		const { codebase } = await fixture({ "src/main.ts": 'import "./auth.js";', "src/auth.ts": 'import "./main.js";\nimport "external";' });
		const trace = await codebase.trace("src/main.ts");
		expect(trace.files).toEqual(["src/main.ts", "src/auth.ts"]);
		expect(trace.kind).toContain("not runtime call order");
		expect(trace.unresolved).toEqual(["external"]);
		expect(trace.truncated).toBe(false);
	});
	it("has a fixed listing budget even on large repositories", async () => {
		const { runtime } = await fixture({});
		vi.spyOn(runtime, "listDirectory").mockResolvedValue(Array.from({ length: 250 }, (_, i) => `dir${i}`));
		vi.spyOn(runtime, "stat").mockResolvedValue({ isDirectory: () => true });
		const model = await new CodebaseModel(runtime).get();
		expect(runtime.listDirectory).toHaveBeenCalledTimes(60);
		expect(model.coverage.truncated).toBe(true);
	});
});

describe("mode policy and persistence", () => {
	it("keeps the workflow, chat, stage and tools in Learn, and narrows tools only for /question practice", () => {
		const workflow = new WorkflowController(createLearningSession("/project", "00000000-0000-0000-0000-000000000001"));
		workflow.state.stage = "implement";
		const state = workflow.state;
		workflow.setLearnMode(true);
		expect(workflow.getAllowedTools()).toContain("codebase_model");
		for (const tool of ["write", "edit", "bash", "student_ask", "learning_state"]) expect(workflow.canUseTool(tool)).toBe(true);
		workflow.setQuestion({ difficulty: "medium", topic: CURRENT_WORK_TOPIC, phase: "generate" });
		for (const tool of ["write", "edit", "student_ask", "student_plan", "learning_state", "save_to_desktop"]) expect(workflow.canUseTool(tool)).toBe(false);
		workflow.setQuestion(undefined);
		workflow.setLearnMode(false);
		expect(workflow.canUseTool("codebase_model")).toBe(false);
		expect(workflow.state).toBe(state);
		expect(workflow.state.id).toBe("00000000-0000-0000-0000-000000000001");
		expect(workflow.getStage()).toBe("implement");
		expect(workflow.canUseTool("edit")).toBe(true);
	});
	it("preserves tighter custom inspection policies", () => {
		const workflow = new WorkflowController(createLearningSession("/project"), { registeredTools: () => ["read"], allowedTools: () => ["read"], canUseTool: (_stage, tool) => tool === "read" });
		workflow.setLearnMode(true);
		expect(workflow.canUseTool("bash")).toBe(false);
		expect(workflow.getAllowedTools()).toEqual(["read", "codebase_model"]);
		workflow.setQuestion({ difficulty: "easy", topic: "runtime", phase: "generate" });
		expect(workflow.canUseTool("bash")).toBe(false);
		expect(workflow.getAllowedTools()).toEqual(["read", "codebase_model"]);
	});
	it("persists independently by project and existing session without writing project files", async () => {
		const dir = await directory(); const store = new LearnSettingsStore(dir);
		expect(await store.read("/project", "one")).toBe(false);
		await store.write("/project", "one", true);
		expect(await new LearnSettingsStore(dir).read("/project", "one")).toBe(true);
		expect(await store.read("/project", "two")).toBe(false);
		expect(await store.read("/other", "one")).toBe(false);
	});
	it.each(["easy", "medium", "hard"] as const)("supports %s question difficulty", difficulty => {
		expect(parseQuestion(`${difficulty} authentication`)).toEqual({ difficulty, topic: "authentication" });
	});
	it("defaults to medium without losing an unspecified topic", () => {
		expect(parseQuestion("runtime")).toEqual({ difficulty: "medium", topic: "runtime" });
		expect(parseQuestion("")).toEqual({ difficulty: "medium", topic: CURRENT_WORK_TOPIC });
	});
	it("TUI command shares GUI settings, keeps thinking independent, and evaluates only explicit practice", async () => {
		const { root, runtime } = await fixture({ "main.py": "print('hello')" });
		const store = new LearnSettingsStore(await directory());
		const workflow = new WorkflowController(createLearningSession(root));
		const hooks = new Map<string, Function[]>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
		const pi = { on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]), registerCommand: (name: string, value: any) => commands.set(name, value), registerTool: (tool: any) => tools.set(tool.name, tool), setActiveTools: vi.fn(), setThinkingLevel: vi.fn(), sendUserMessage: vi.fn() };
		const ctx = { sessionManager: { getSessionId: () => "session" }, ui: { setStatus: vi.fn(), notify: vi.fn() }, isIdle: () => true };
		const mode = registerLearnMode(pi as never, workflow, runtime, store);
		const emit = async (event: string, payload = {}) => { for (const handler of hooks.get(event) ?? []) await handler(payload, ctx); };
		await emit("session_start");
		await commands.get("learn").handler("", ctx);
		expect(await store.read(root, "session")).toBe(true);
		expect(mode.learnGuidance()).toBe(LEARN_GUIDANCE);
		expect(mode.questionGuidance()).toBeUndefined();
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();
		const model = await mode.codebase.get();
		await commands.get("question").handler("hard runtime", ctx);
		await emit("before_agent_start");
		expect(mode.questionGuidance()).toContain("Ask exactly one");
		expect(mode.questionGuidance()).toContain("current work");
		expect(mode.questionGuidance()).toContain("never reproduce secrets");
		// Learn scaffolding steps aside while a practice question is running.
		expect(mode.learnGuidance()).toBeUndefined();
		expect(await mode.codebase.get()).toBe(model);
		await emit("agent_settled");
		expect(workflow.state.question?.phase).toBe("answer");
		await emit("before_agent_start");
		expect(mode.questionGuidance()).toContain("Evaluate the student's answer");
		await emit("agent_settled");
		expect(workflow.state.question).toBeUndefined();
		expect(mode.learnGuidance()).toBe(LEARN_GUIDANCE);
		// Simulate GUI setting change. Applies to the next turn, never a new session.
		await store.write(root, "session", false); await emit("before_agent_start");
		expect(mode.learnGuidance()).toBeUndefined();
	});
	it("rejects cross-project and non-Pi GUI session lookups", async () => {
		const home = await directory(); const project = "/tmp/example";
		await mkdir(path.join(home, "agents", "tmp-example"), { recursive: true });
		const file = path.join(home, "agents", "tmp-example", "agent-1.json");
		await writeFile(file, JSON.stringify({ id: "agent-1", provider: "pi-student", cwd: project, workspaceId: "wks_one", runtimeInfo: { sessionId: "pi-session" } }));
		expect(await resolveLearnSession(home, project, "wks_one", "agent-1")).toBe("pi-session");
		await expect(resolveLearnSession(home, project, "wks_other", "agent-1")).rejects.toThrow("not an active");
		await expect(resolveLearnSession(home, project, "wks_one", "../agent-1")).rejects.toThrow("Select");
		await writeFile(file, JSON.stringify({ id: "agent-1", provider: "pi", cwd: project, workspaceId: "wks_one", runtimeInfo: { sessionId: "pi-session" } }));
		await expect(resolveLearnSession(home, project, "wks_one", "agent-1")).rejects.toThrow("not an active");
	});
});
