import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isSafeInspectionCommand, isSafeVerificationCommand } from "../terminal/command-policy.js";
import { createSandboxToolDefinitions, createSandboxGrepTool } from "../sandbox/sandbox-manager.js";
import { HostRuntime } from "../sandbox/host-runtime.js";
import { restoreWorkflow } from "../pi/create-session.js";
import { inspectProjectContext } from "../education/project-context.js";
import { createReplUI } from "../terminal/repl.js";
import { installLauncher } from "../install/launcher.js";
import { getInstallationPaths } from "../install/paths.js";

describe("review regressions", () => {
	it.each(["find src -delete", "sed -i s/a/b/g src/app.ts", "git status; touch changed.txt", "git diff --output=changed.txt", "git status\ntouch changed.txt"])("blocks mutation through inspection: %s", command => {
		expect(isSafeInspectionCommand(command, "/workspace")).toBe(false);
		expect(isSafeVerificationCommand(command, "/workspace")).toBe(false);
	});
	it("rejects compound verification but preserves ordinary inspection and tests", () => {
		expect(isSafeVerificationCommand("npm test; touch changed.txt", "/workspace")).toBe(false);
		expect(isSafeVerificationCommand("npm run build", "/workspace")).toBe(true);
		expect(isSafeInspectionCommand("find src -type f", "/workspace")).toBe(true);
	});
	it("starts new workflows fresh and restores detached branch snapshots", () => {
		const manager = SessionManager.inMemory("/project");
		const workflow = restoreWorkflow(manager, "/project");
		workflow.updateLearningState({ currentStage: "understand", readyForNextStage: true, goalSummary: "Build", understandingReady: true, reason: "ready" });
		manager.appendCustomEntry("pi-student-workflow", structuredClone(workflow.state));
		const restored = restoreWorkflow(manager, "/project");
		expect(restored.getStage()).toBe("plan");
		restored.state.plan.approved = true;
		expect(restoreWorkflow(manager, "/project").state.plan.approved).toBe(false);
		expect(restoreWorkflow(SessionManager.inMemory("/project"), "/project").getStage()).toBe("understand");
	});
	it("reads valid PNG bytes and caps long grep matches", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-review-"));
		const runtime = new HostRuntime();
		try {
			await runtime.start(root);
			const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
			await writeFile(path.join(root, "image.png"), png);
			const tool = createSandboxToolDefinitions(runtime).find(tool => tool.name === "read")!;
			const result = await tool.execute("read", { path: "image.png" }, undefined, undefined, {} as never);
			expect(result.content.some(content => content.type === "image")).toBe(true);
			await writeFile(path.join(root, "bundle.js"), "x".repeat(1_000_000));
			const grep = await createSandboxGrepTool(runtime).execute("grep", { pattern: "x", path: "bundle.js", limit: 1 }, undefined, undefined, {} as never);
			expect(JSON.stringify(grep).length).toBeLessThan(52_000);
			expect(grep.details).toMatchObject({ truncated: true });
		} finally { await runtime.stop(); await rm(root, { recursive: true, force: true }); }
	});
	it("discovers manifests without recursively scanning the project", async () => {
		let reads = 0;
		const runtime = new HostRuntime();
		runtime.listFiles = async () => { throw new Error("Recursive listing must not be called"); };
		runtime.listDirectory = async directory => { reads++; return directory === "/workspace" ? ["package.json", "src", ".venv"] : ["app.ts"]; };
		runtime.readFile = async file => { if (file.endsWith("package.json")) return '{"dependencies":{"react":"1"}}'; throw new Error("missing"); };
		const context = await inspectProjectContext(runtime);
		expect(context.frameworks).toContain("React");
		expect(context.languages).toContain("TypeScript");
		expect(reads).toBe(2);
	});
	it("accepts plain terminal student answers and explicit approval", async () => {
		const answers = ["My step", "yes", "2", "/cancel"];
		const ui = createReplUI({} as ExtensionUIContext, { next: async () => ({ done: false, value: answers.shift()! }) }, () => {});
		expect(await ui.input("step")).toBe("My step");
		expect(await ui.confirm("approve", "plan")).toBe(true);
		expect(await ui.select("choose", ["A", "B"])).toBe("B");
		expect(await ui.input("cancel")).toBeUndefined();
	});
	it("renders a release installer that proceeds using its default URL", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-installer-"));
		try {
			const source = await readFile("install.sh", "utf8");
			const rendered = source.replaceAll("__PI_STUDENT_RELEASE_BASE_URL__", "https://example.com/releases/latest/download").replace(/main "\$@"\s*$/, `
 detect_platform() { PLATFORM=test; }
 install_node() { say NODE_REACHED; }
 install_voz() { :; }
 install_application() { :; }
 install_paseo() { :; }
 ensure_path() { :; }
 verify_installation() { :; }
 main "$@"
`);
			const output = execFileSync("sh", ["-s"], { input: rendered, env: { ...process.env, PI_STUDENT_HOME: root, PI_STUDENT_RELEASE_BASE_URL: "" }, encoding: "utf8" });
			expect(output).toContain("NODE_REACHED");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
	it("embeds custom install paths with safe shell quoting", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "pi-launcher-"));
		try {
			const paths = getInstallationPaths({ PI_STUDENT_HOME: path.join(root, "custom ' directory") });
			await installLauncher(paths);
			const script = await readFile(paths.launcher, "utf8");
			const probe = script.slice(0, script.indexOf("if [ ! -x")) + 'printf "%s" "$PI_STUDENT_HOME"';
			const output = execFileSync("sh", ["-s"], { input: probe, env: { ...process.env, PI_STUDENT_HOME: "" }, encoding: "utf8" });
			expect(output).toBe(paths.root);
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});
