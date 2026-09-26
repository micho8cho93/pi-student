import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { findBrowser, startBrowserWorkspace, WORKING, type WorkspaceId } from "./browser/workspace-harness.js";

/**
 * Browser-level student journeys: system Chrome drives Pi Student's production GUI
 * scripts (Map, progress, editor, terminal) inside a Paseo-shaped shell, against
 * the real ecosystem bridge, journal, files and `npm test` subprocesses. The Chat
 * model's replies and Pi's extension dispatcher are the only controlled parts.
 */
const executablePath = findBrowser();
// CI must run these; a developer machine without Chrome skips them visibly.
if (!executablePath && process.env.CI) throw new Error("The browser journey needs Chrome or Chromium. Set PI_STUDENT_TEST_BROWSER.");

let browser: Browser;
let harness: Awaited<ReturnType<typeof startBrowserWorkspace>> | undefined;
beforeAll(async () => { if (executablePath) browser = await chromium.launch({ executablePath, headless: true }); });
afterAll(async () => { await browser?.close(); });
afterEach(async () => { await harness?.close(); harness = undefined; }, 30_000);

const poll = <T>(read: () => Promise<T>, timeout = 15_000) => expect.poll(read, { timeout, interval: 150 });
const text = (page: Page, selector: string) => page.locator(selector).first().textContent().then(value => value ?? "", () => "");

const pageErrors: string[] = [];
afterEach(() => { expect(pageErrors.splice(0)).toEqual([]); });

async function openWorkspace(id: WorkspaceId) {
	const page = await browser.newPage();
	page.on("pageerror", error => { pageErrors.push(error.message); });
	await page.goto(`${harness!.shellOrigin}/workspace/${id}`);
	await page.locator(".cm-content").waitFor();
	return page;
}

/** Replaces the open file by typing into CodeMirror, as the student would. */
async function typeCode(page: Page, code: string) {
	await page.locator(".cm-content").click();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.press("Backspace");
	await page.keyboard.type(code.trimEnd(), { delay: 5 });
	await page.keyboard.press("Escape");
	await page.evaluate(() => window.shell.saved());
}

async function runInTerminal(page: Page, command: string) {
	await page.waitForFunction(() => window.__terminalAttached === true);
	const before = await text(page, "#terminal-status");
	await page.locator("#terminal-command").fill(command);
	await page.locator("#terminal-command").press("Enter");
	await page.waitForFunction(previous => { const status = document.getElementById("terminal-status")!.textContent!; return status.startsWith("exit") && status !== previous; }, before);
	return Number((await text(page, "#terminal-status")).replace("exit ", ""));
}

async function askChat(page: Page) {
	const turns = await page.locator(".turn").count();
	await page.locator("#chat-input").fill("What should I look at next?");
	await page.locator("#chat-send").click();
	await page.locator(".turn").nth(turns).waitFor();
	return text(page, `.turn >> nth=${turns}`);
}

describe.skipIf(!executablePath)("browser student journeys", () => {
	it("Map → Chat → implementation → edit → failing test → fix → stale map → switch projects → return", async () => {
		harness = await startBrowserWorkspace();
		const h = harness;
		// 1. Open project A.
		const page = await openWorkspace("wks_a");
		const a = await h.chat("wks_a");

		// 2. Open the Map from the new-tab menu; there is no saved map yet, so it is generated.
		await page.locator("#new-tab").click();
		await page.locator("[data-pi-student-flowchart-choice]").click();
		const node = page.locator('#pi-student-flowchart [data-node-id="score"]');
		await node.waitFor();
		expect(h.modelRequests).toHaveLength(1);

		// 3. Select a Map node.
		await node.click();
		await poll(() => text(page, "#pi-student-flowchart .selection")).toContain("Award points");
		await poll(async () => (await h.snapshot("wks_a")).map.selectedNode?.id).toBe("score");

		// 4–5. Open Chat; its next turn has the selected node as context.
		await page.locator("#chat-tab").click();
		await page.locator("#pi-student-flowchart").waitFor({ state: "hidden" });
		expect(await askChat(page)).toContain('Selected node: "Award points" — score.js:1 (score)');

		// 6. Move through the educational workflow into implementation; progress follows Chat live.
		a.workflow.updateLearningState({ currentStage: "understand", goalSummary: "Award two points", understandingReady: true, readyForNextStage: true });
		a.workflow.addStudentPlanStep("Return two points from score");
		a.workflow.approveStudentPlan("I will check it with the score test");
		a.workflow.updateLearningState({ currentStage: "plan", planSummary: "Change scoring and verify", readyForNextStage: true });
		expect(a.workflow.getStage()).toBe("implement");
		await h.journal.flush();
		await poll(() => text(page, "#pi-student-project-progress .summary")).toContain("Implement");
		expect((await h.snapshot("wks_a")).learning).toMatchObject({ stage: "implement", source: "live", planApproved: true, activeStep: "Return two points from score" });

		// 7. Edit code in the student's editor (with a mistake).
		await typeCode(page, "export function score() { return 3; }");
		expect(await readFile(path.join(h.projects.wks_a, "score.js"), "utf8")).toBe("export function score() { return 3; }");
		await poll(async () => (await h.snapshot("wks_a")).activity.recentChanges).toContainEqual(expect.objectContaining({ file: "score.js", author: "student" }));

		// 8–9. Run the test in the terminal; it fails and Chat learns why without the raw output.
		expect(await runInTerminal(page, "npm test")).toBe(1);
		await poll(() => text(page, "#terminal-output")).toContain("unrelated check 39");
		await poll(async () => (await h.snapshot("wks_a")).activity.lastTest).toMatchObject({ passed: false, actor: "student", failedTests: ["score.test.js > awards two points"] });
		const aware = await askChat(page);
		expect(aware).toContain("score.test.js > awards two points failed (`npm test`, run by the student, exit 1)");
		expect(aware).toContain("Student modified (typed themselves):\n- score.js");
		expect(aware).toContain("AssertionError: expected 3 to equal 2");
		for (const leaked of ["unrelated check", "ghp_", "sk-live", ".env", h.root]) expect(aware).not.toContain(leaked);
		expect(aware.length).toBeLessThan(2_000);
		expect((await h.snapshot("wks_a")).activity.lastTest).not.toHaveProperty("summary");

		// 10. Fix the problem.
		await typeCode(page, WORKING);
		expect(await runInTerminal(page, "npm test")).toBe(0);
		await poll(async () => (await h.snapshot("wks_a")).activity.lastTest?.passed).toBe(true);

		// 11. The Map is stale after the source change, and is not regenerated.
		await page.locator("[data-pi-student-flowchart-tab]").click();
		await poll(() => text(page, "#pi-student-flowchart .meta")).toContain("Out of date");
		expect((await h.snapshot("wks_a")).map).toMatchObject({ available: true, stale: true, staleFiles: ["score.js"] });
		expect(h.modelRequests).toHaveLength(1);

		// 12–13. Switch to project B: none of A's map, selection, failure, progress or Chat context follows.
		await page.evaluate(() => window.shell.navigate("wks_b"));
		await poll(() => page.locator("[data-pi-student-flowchart-tab]").count()).toBe(0);
		await page.locator("#pi-student-flowchart").waitFor({ state: "hidden" });
		await poll(() => text(page, "#pi-student-project-progress .summary")).toContain("Understand project");
		const b = await h.chat("wks_b");
		const bContext = await askChat(page);
		for (const leaked of ["Award points", "awards two points", "Out of date", "Student modified"]) expect(bContext).not.toContain(leaked);
		expect((await h.snapshot("wks_b")).map).toMatchObject({ available: false });
		// Session-only state stays in its session: B's Learn and a failed B reply do not reach A.
		b.workflow.setLearnMode(true);
		await b.turn({ stopReason: "error" });
		expect((await h.snapshot("wks_b")).learn.enabled).toBe(true);
		expect((await h.snapshot("wks_b")).model).toMatchObject({ available: false, reason: "provider_unavailable" });

		// 14–15. Return to A: durable project state (map, selection, staleness, progress) is restored; B's session state is not.
		await page.evaluate(() => window.shell.navigate("wks_a"));
		await page.locator("[data-pi-student-flowchart-tab]").waitFor();
		await page.locator("[data-pi-student-flowchart-tab]").click();
		await poll(() => page.locator('#pi-student-flowchart [data-node-id="score"]').getAttribute("aria-pressed")).toBe("true");
		await poll(() => text(page, "#pi-student-flowchart .meta")).toContain("Out of date");
		await poll(() => text(page, "#pi-student-flowchart .selection .hint")).toBe("Chat can see the selected step.");
		await poll(() => text(page, "#pi-student-project-progress .summary")).toContain("Implement");
		const aSnapshot = await h.snapshot("wks_a");
		expect(aSnapshot.learn.enabled).toBe(false);
		expect(aSnapshot.model.available).toBe(true);
		expect(aSnapshot.actions.find((action: { action: string }) => action.action === "ask-guidance")).toMatchObject({ available: true });

		// A full reload (and bridge restart) keeps the saved map open with its selection and staleness, without AI.
		await h.startBridge();
		await page.reload();
		await page.locator('#pi-student-flowchart [data-node-id="score"]').waitFor();
		await page.locator("#pi-student-flowchart").waitFor({ state: "visible" });
		await poll(() => page.locator('#pi-student-flowchart [data-node-id="score"]').getAttribute("aria-pressed")).toBe("true");
		await poll(() => text(page, "#pi-student-flowchart .meta")).toContain("Out of date");
		expect(h.modelRequests).toHaveLength(1);
		await page.close();
	}, 120_000);

	it("degraded AI: an unavailable model leaves the editor, terminal and existing map working with fallback guidance", async () => {
		harness = await startBrowserWorkspace();
		const h = harness;
		const generated = await fetch(`${h.bridgeUrl()}/flowchart?workspaceId=wks_a`, { method: "POST", headers: { "Content-Type": "application/json", "X-Pi-Student": "ecosystem" }, body: "{}" });
		expect(generated.status).toBe(200);
		h.outage(true);
		const page = await openWorkspace("wks_a");
		const a = await h.chat("wks_a");
		// Chat's provider fails; every surface learns it from the same snapshot.
		await a.turn({ stopReason: "error" });
		expect(a.notices.at(-1)).toContain("The AI model is unavailable right now");
		await poll(() => text(page, "#pi-student-project-progress .next")).toContain("The AI model is unavailable right now.");
		await poll(() => text(page, "#pi-student-project-progress .next")).toContain("Code and Terminal are still available.");
		const degraded = await h.snapshot("wks_a");
		expect(degraded.model).toMatchObject({ available: false, reason: "provider_unavailable" });
		for (const action of ["open-editor", "use-terminal", "run-tests", "view-map"]) {
			expect(degraded.actions.find((item: { action: string }) => item.action === action)).toMatchObject({ available: true });
		}
		expect(degraded.fallback.canStill).toEqual(expect.arrayContaining(["edit the code yourself", "inspect the architecture in the flowchart", "run tests", "use the terminal"]));

		// The existing map opens without AI; a failed refresh keeps it.
		const requests = h.modelRequests.length;
		await page.locator("[data-pi-student-flowchart-tab]").click();
		await page.locator('#pi-student-flowchart [data-node-id="score"]').waitFor();
		expect(h.modelRequests).toHaveLength(requests);
		await page.locator("#pi-student-flowchart .refresh").click();
		await poll(() => text(page, "#pi-student-flowchart .refresh-error")).toContain("Showing the previous flowchart.");
		await poll(() => text(page, "#pi-student-flowchart .refresh-error")).toContain("edit the code yourself");
		await page.locator('#pi-student-flowchart [data-node-id="score"]').waitFor({ state: "visible" });
		expect((await (await fetch(`${h.bridgeUrl()}/flowchart?workspaceId=wks_a`)).json()).chart.nodes).toHaveLength(2);

		// Manual editing and the student's terminal keep working.
		await page.locator("#chat-tab").click();
		await typeCode(page, WORKING);
		expect(await runInTerminal(page, "npm test")).toBe(0);
		await poll(async () => (await h.snapshot("wks_a")).activity.lastTest?.passed).toBe(true);

		// When Chat recovers, the same surfaces offer AI help again.
		h.outage(false);
		await a.turn();
		await poll(async () => (await h.snapshot("wks_a")).model.available).toBe(true);
		await poll(() => text(page, "#pi-student-project-progress .next")).not.toContain("unavailable");
		await page.close();
	}, 120_000);
});
