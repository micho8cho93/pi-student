import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { patchGitStateSource, patchCommitsUiSource, patchCommitHistorySource } from "../integrations/paseo/git-state-patch.js";

const serverRoot = path.resolve("node_modules/@getpaseo/server/dist/server");
const servicePath = path.join(serverRoot, "server/workspace-git-service.js");
const logger: any = { child: () => logger, debug() {}, info() {}, warn() {}, error() {}, trace() {} };

describe("Paseo repository discovery", () => {
	it("recovers a cached non-Git workspace after initial publish and reads commits and diffs", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "pi-git-discovery-"));
		const patchedPath = path.join(path.dirname(servicePath), `pi-git-test-${process.pid}.js`);
		const patchedGitPath = path.join(serverRoot, "utils", `pi-git-history-test-${process.pid}.js`);
		let service: any;
		try {
			const original = await readFile(servicePath, "utf8");
			const patched = patchGitStateSource(original);
			expect(patchGitStateSource(patched)).toBe(patched);
			await writeFile(patchedPath, patched);
			const { WorkspaceGitServiceImpl } = await import(pathToFileURL(patchedPath).href);
			let now = Date.now();
			service = new WorkspaceGitServiceImpl({ logger, deps: { now: () => new Date(now) } });
			expect((await service.getSnapshot(directory, { includeForge: false })).git.isGit).toBe(false);
			const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
			git("init", "-b", "main");
			git("config", "user.name", "Test");
			git("config", "user.email", "test@example.com");
			await writeFile(path.join(directory, "index.html"), "original\n");
			git("add", ".");
			git("commit", "-m", "Initial publish from Pi");
			now += 5000;
			const recovered = await service.getSnapshot(directory, { includeForge: false });
			expect(recovered.git.isGit).toBe(true);
			expect(recovered.git.currentBranch).toBe("main");
			await writeFile(patchedGitPath, patchCommitHistorySource(await readFile(path.join(serverRoot, "utils/checkout-git.js"), "utf8")));
			const gitApi = await import(pathToFileURL(patchedGitPath).href);
			const history = await gitApi.listCheckoutCommits({ cwd: directory });
			expect(history.commits[0].subject).toBe("Initial publish from Pi");
			const initialDiff = await gitApi.getCommitFileDiff({ cwd: directory, sha: history.commits[0].sha, path: "index.html" });
			expect(initialDiff.hunks.length).toBeGreaterThan(0);
			for (let i = 0; i < 11; i++) git("commit", "--allow-empty", "-m", `Update ${i}`);
			expect((await gitApi.listCheckoutCommits({ cwd: directory })).commits).toHaveLength(12);
			await writeFile(path.join(directory, "index.html"), "changed\n");
			const diff = await service.getCheckoutDiff(directory, { mode: "uncommitted", includeStructured: true });
			expect(diff.structured[0].path).toBe("index.html");
			expect(diff.structured[0].hunks.length).toBeGreaterThan(0);
		} finally {
			await service?.dispose();
			await rm(patchedPath, { force: true });
			await rm(patchedGitPath, { force: true });
			await rm(directory, { recursive: true, force: true });
		}
	}, 30000);

	it("shows base and published commits in the panel and removes the ten-commit cap", async () => {
		const { readdir } = await import("node:fs/promises");
		const bundleRoot = path.join(serverRoot, "web-ui/_expo/static/js/web");
		const name = (await readdir(bundleRoot)).find(name => /^index-.*\.js$/.test(name))!;
		const patched = patchCommitsUiSource(await readFile(path.join(bundleRoot, name), "utf8"));
		const section = patched.split("\n").find(line => line.includes(".CommitsSection=function"))!;
		expect(section).not.toMatch(/return![\w$]+\.isOnBase/);
		expect(patchCommitsUiSource(patched)).toBe(patched);
		const history = patchCommitHistorySource(await readFile(path.join(serverRoot, "utils/checkout-git.js"), "utf8"));
		expect(history).not.toContain("maxCount: CHECKOUT_BASE_COMMIT_LIMIT,");
	});

	it("rechecks subscribed non-Git folders on the existing self-heal timer", async () => {
		const patchedPath = path.join(path.dirname(servicePath), `pi-git-timer-test-${process.pid}.js`);
		let service: any;
		try {
			await writeFile(patchedPath, patchGitStateSource(await readFile(servicePath, "utf8")));
			const { WorkspaceGitServiceImpl } = await import(pathToFileURL(patchedPath).href);
			service = new WorkspaceGitServiceImpl({ logger });
			const target = { cwd: "/tmp/pi-test", latestFacts: { isGit: false }, observationReensureTimer: null };
			service.isActiveObservedWorkspaceTarget = () => true;
			service.updateForgePrStatusPollForTarget = () => {};
			service.scheduleWorkspaceObservationSetup = vi.fn();
			service.scheduleWorkspaceRefresh = vi.fn();
			vi.useFakeTimers();
			service.startWorkspaceSubscriptionTimers(target);
			await vi.advanceTimersByTimeAsync(60000);
			expect(service.scheduleWorkspaceRefresh).toHaveBeenCalledWith(target, expect.objectContaining({ scope: "structure" }));
			clearTimeout(target.observationReensureTimer!);
		} finally {
			vi.useRealTimers();
			await service?.dispose();
			await rm(patchedPath, { force: true });
		}
	});

	it("rejects unknown vendor code instead of partially patching it", () => {
		expect(() => patchGitStateSource("export class OtherService {}" )).toThrow("incompatible");
	});
});
