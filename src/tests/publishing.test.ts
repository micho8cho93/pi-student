import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { detectProjectType } from "../publishing/project-detection.js";
import { GitRunner, type CommandExecutor } from "../publishing/git-runner.js";
import { PublishingMetadataStore } from "../publishing/metadata-store.js";
import { parseGitHubRemote, PublishingService } from "../publishing/publishing-service.js";
import { sanitizeRepositoryName, scanPublishableFiles } from "../publishing/security.js";
import { ECOSYSTEM_BRIDGE_PORT, resolvePaseoWorkspacePath } from "../publishing/ecosystem-bridge.js";
import { GhGitHubClient } from "../publishing/github-client.js";
import type { GitHubClient, GitHubConnection, GitHubPagesStatus, RepositorySummary } from "../publishing/types.js";

const execFileAsync = promisify(execFile);

class FakeGitHub implements GitHubClient {
	readonly repositories = new Map<string, RepositorySummary>();
	configured: Array<{ owner: string; repo: string; branch: string; deploymentType: string }> = [];
	pages: GitHubPagesStatus = { status: "built", url: "https://student.github.io/project/" };
	connection: GitHubConnection = { connected: true, username: "student" };

	async getConnection() { return this.connection; }
	async connect() { return this.connection; }
	async listRepositories() { return [...this.repositories.values()]; }
	async getRepository(owner: string, repo: string) { return this.repositories.get(`${owner}/${repo}`); }
	async createRepository(name: string) {
		const repository = repo("student", name);
		this.repositories.set(repository.fullName, repository);
		return repository;
	}
	async configurePages(owner: string, repoName: string, branch: string, deploymentType: "branch" | "github-actions") { this.configured.push({ owner, repo: repoName, branch, deploymentType }); }
	async getPagesStatus() { return this.pages; }
}

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-publish-"));
	const project = path.join(root, "My Portfolio");
	await mkdir(project);
	const metadata = new PublishingMetadataStore(path.join(root, "metadata"));
	const calls: string[][] = [];
	const execute: CommandExecutor = async (command, args, cwd) => {
		calls.push(args);
		if (args[0] === "push") return { stdout: "", stderr: "" };
		const result = await execFileAsync(command, args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig") } });
		return { stdout: result.stdout, stderr: result.stderr };
	};
	return { root, project, metadata, git: new GitRunner(execute), calls };
}

describe("project detection", () => {
	it("detects static and common framework projects", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-detect-"));
		try {
			await writeFile(path.join(root, "index.html"), "hello");
			expect((await detectProjectType(root)).kind).toBe("static");
			for (const [dependency, kind] of [["vite", "vite"], ["react-scripts", "react"], ["astro", "astro"], ["svelte", "svelte"]] as const) {
				await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "build" }, devDependencies: { [dependency]: "1" } }));
				expect((await detectProjectType(root)).kind).toBe(kind);
			}
			await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { start: "node app" } }));
			expect((await detectProjectType(root)).kind).toBe("unsupported");
		} finally { await rm(root, { recursive: true, force: true }); }
	});
});

describe("publishing service", () => {
	it("publishes a static site, creates one repository, and reuses it on update", async () => {
		const f = await fixture();
		const github = new FakeGitHub();
		const progress: string[] = [];
		try {
			await writeFile(path.join(f.project, "index.html"), "<h1>Hello</h1>");
			await writeFile(path.join(f.project, ".env"), "API_KEY=do-not-publish");
			const service = new PublishingService({ github, git: f.git, metadata: f.metadata, confirmPublic: async () => true, wait: async () => {}, maxStatusChecks: 1, onProgress: item => progress.push(item.message) });
			const first = await service.publish(f.project);
			expect(first).toMatchObject({ owner: "student", repository: "my-portfolio", branch: "main", url: github.pages.url });
			expect(github.repositories.size).toBe(1);
			expect(github.configured[0]).toMatchObject({ branch: "main", deploymentType: "branch" });
			expect(progress).toContain("Created Git repository");
			expect((await f.git.run(f.project, ["ls-files"])).stdout).not.toContain(".env");
			expect((await f.git.run(f.project, ["log", "-1", "--pretty=%s"])).stdout.trim()).toBe("Initial publish from Pi");

			await writeFile(path.join(f.project, "index.html"), "<h1>Updated</h1>");
			await service.publish(f.project);
			expect(github.repositories.size).toBe(1);
			expect((await f.git.run(f.project, ["log", "-1", "--pretty=%s"])).stdout.trim()).toBe("Publish update from Pi");
			const saved = await f.metadata.read(f.project);
			expect(saved?.deployment?.history).toHaveLength(2);
			expect(saved?.deployment?.status).toBe("published");
		} finally { await rm(f.root, { recursive: true, force: true }); }
	}, 15_000);

	it("requires public consent and records failed deployments", async () => {
		const f = await fixture();
		const github = new FakeGitHub();
		try {
			await writeFile(path.join(f.project, "index.html"), "hello");
			await expect(new PublishingService({ github, git: f.git, metadata: f.metadata, confirmPublic: async () => false }).publish(f.project)).rejects.toThrow(/cancelled/);
			expect(github.repositories.size).toBe(0);

			github.pages = { status: "errored", error: "The build command failed." };
			await expect(new PublishingService({ github, git: f.git, metadata: f.metadata, confirmPublic: async () => true, wait: async () => {}, maxStatusChecks: 1 }).publish(f.project)).rejects.toThrow(/build command failed/);
			expect((await f.metadata.read(f.project))?.deployment).toMatchObject({ status: "failed", lastError: expect.stringContaining("build command failed") });
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});

	it("creates a managed Actions workflow for framework sites without overwriting an existing workflow", async () => {
		const f = await fixture();
		const github = new FakeGitHub();
		try {
			await writeFile(path.join(f.project, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { vite: "1" } }));
			const service = new PublishingService({ github, git: f.git, metadata: f.metadata, confirmPublic: async () => true, wait: async () => {}, maxStatusChecks: 1 });
			await service.publish(f.project);
			const workflowPath = path.join(f.project, ".github/workflows/pi-pages.yml");
			const generated = await readFile(workflowPath, "utf8");
			expect(generated).toContain("Managed by Pi Student");
			expect(generated).toContain("actions/configure-pages@v5");
			expect(generated).toContain("actions/upload-pages-artifact@v4");
			expect(generated).toContain("actions/deploy-pages@v4");
			expect(github.configured[0]?.deploymentType).toBe("github-actions");
			await writeFile(workflowPath, "# student customization\n");
			await writeFile(path.join(f.project, "src.js"), "changed");
			await service.publish(f.project);
			expect(await readFile(workflowPath, "utf8")).toBe("# student customization\n");
		} finally { await rm(f.root, { recursive: true, force: true }); }
	}, 15_000);

	it("blocks detected secrets before staging them", async () => {
		const f = await fixture();
		const github = new FakeGitHub();
		try {
			await writeFile(path.join(f.project, "index.html"), "<script>const api_key='12345678901234567890'</script>");
			await expect(new PublishingService({ github, git: f.git, metadata: f.metadata, confirmPublic: async () => true }).publish(f.project)).rejects.toThrow(/may contain secrets/);
			expect((await f.git.run(f.project, ["status", "--porcelain"])).stdout).not.toMatch(/^A/m);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});

	it("reuses an existing GitHub origin and preserves its branch", async () => {
		const f = await fixture();
		const github = new FakeGitHub();
		github.repositories.set("classroom/existing-site", repo("classroom", "existing-site"));
		try {
			await writeFile(path.join(f.project, "index.html"), "existing");
			await f.git.run(f.project, ["init"]);
			await f.git.run(f.project, ["branch", "-M", "develop"]);
			await f.git.run(f.project, ["remote", "add", "origin", "git@github.com:classroom/existing-site.git"]);
			const result = await new PublishingService({ github, git: f.git, metadata: f.metadata, wait: async () => {}, maxStatusChecks: 1 }).publish(f.project);
			expect(result).toMatchObject({ owner: "classroom", repository: "existing-site", branch: "develop" });
			expect(github.repositories.size).toBe(1);
			expect((await f.git.run(f.project, ["remote", "get-url", "origin"])).stdout.trim()).toBe("git@github.com:classroom/existing-site.git");
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});

	it("refuses to publish a nested folder from a larger repository", async () => {
		const f = await fixture();
		try {
			await f.git.run(f.root, ["init"]);
			await writeFile(path.join(f.project, "index.html"), "nested");
			await expect(new PublishingService({ github: new FakeGitHub(), git: f.git, metadata: f.metadata, confirmPublic: async () => true }).publish(f.project)).rejects.toThrow(/larger Git repository/);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

describe("publishing helpers", () => {
	it("sanitizes names and accepts only GitHub remotes", () => {
		expect(sanitizeRepositoryName("My Café Website!" )).toBe("my-cafe-website");
		expect(parseGitHubRemote("git@github.com:alex/portfolio.git")).toEqual({ owner: "alex", repo: "portfolio" });
		expect(parseGitHubRemote("https://gitlab.com/alex/portfolio.git")).toBeUndefined();
	});

	it("uses one local bridge and resolves only registered Paseo workspace ids", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pi-paseo-workspaces-"));
		const paseoHome = path.join(root, "paseo");
		const project = path.join(root, "student-site");
		try {
			await mkdir(path.join(paseoHome, "projects"), { recursive: true });
			await writeFile(path.join(paseoHome, "projects", "workspaces.json"), JSON.stringify([
				{ workspaceId: "wks_student-1", cwd: project },
			]));
			expect(ECOSYSTEM_BRIDGE_PORT).toBe(6769);
			expect(await resolvePaseoWorkspacePath(paseoHome, "wks_student-1", "/fallback")).toBe(project);
			expect(await resolvePaseoWorkspacePath(paseoHome, undefined, "/fallback")).toBe("/fallback");
			await expect(resolvePaseoWorkspacePath(paseoHome, "../../etc", "/fallback")).rejects.toThrow(/identifier is invalid/);
			await expect(resolvePaseoWorkspacePath(paseoHome, "wks_missing", "/fallback")).rejects.toThrow(/active Paseo workspace/);
		} finally { await rm(root, { recursive: true, force: true }); }
	});

	it("reports tracked sensitive files", async () => {
		const f = await fixture();
		try {
			await f.git.run(f.project, ["init"]);
			await writeFile(path.join(f.project, ".env"), "TOKEN=value");
			await f.git.run(f.project, ["add", ".env"]);
			expect(await scanPublishableFiles(f.project, f.git)).toEqual([expect.stringContaining("sensitive file")]);
		} finally { await rm(f.root, { recursive: true, force: true }); }
	});
});

describe("GitHub API adapter", () => {
	it("never returns an authentication token in connection errors", async () => {
		const client = new GhGitHubClient(async () => { throw new Error("HTTP 401 for ghp_123456789012345678901234567890123456"); });
		const connection = await client.getConnection();
		expect(connection.connected).toBe(false);
		expect(connection.reason).toContain("authorization is missing or expired");
		expect(connection.reason).not.toContain("ghp_");
	});

	it("maps a failed Actions step to a student-facing Pages failure", async () => {
		const client = new GhGitHubClient(async args => {
			const route = args[1];
			if (route === "/repos/student/site/pages") return JSON.stringify({ html_url: "https://student.github.io/site/", status: "building" });
			if (String(route).includes("actions/workflows")) return JSON.stringify({ workflow_runs: [{ id: 42, status: "completed", conclusion: "failure", head_sha: "abc123", html_url: "https://github.com/student/site/actions/runs/42" }] });
			if (String(route).includes("actions/runs/42/jobs")) return JSON.stringify({ jobs: [{ steps: [{ name: "Build website", conclusion: "failure" }] }] });
			throw new Error(`unexpected ${String(route)}`);
		});
		expect(await client.getPagesStatus("student", "site")).toMatchObject({ status: "errored", commit: "abc123", error: expect.stringContaining("Build website") });
	});
});

function repo(owner: string, name: string): RepositorySummary {
	return { owner, name, fullName: `${owner}/${name}`, url: `https://github.com/${owner}/${name}`, visibility: "public", defaultBranch: "main" };
}
