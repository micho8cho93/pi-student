import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitHubClient, GitHubConnection, GitHubPagesStatus, RepositorySummary } from "./types.js";

import { browserLogin, githubExecutable, type GitHubSignInProgress } from "./github-runtime.js";

const execFileAsync = promisify(execFile);

export type GitHubCommandExecutor = (args: string[]) => Promise<string>;

export class GhGitHubClient implements GitHubClient {
	constructor(private readonly execute: GitHubCommandExecutor = executeGh, private readonly onSignIn: (progress: GitHubSignInProgress) => void = progress => {
		if (progress.code) {
			process.stdout.write(`Enter code ${progress.code} at ${progress.url}\n`);
			const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
			execFile(command, ["https://github.com/login/device"], () => {});
		}
	}) {}

	async getConnection(): Promise<GitHubConnection> {
		try {
			const user = await this.api("GET", "user") as { login?: string };
			return user.login ? { connected: true, username: user.login } : { connected: false, reason: "GitHub did not return an account name." };
		} catch (error) {
			return { connected: false, reason: friendlyGitHubError(error) };
		}
	}

	async connect(): Promise<GitHubConnection> {
		try {
			if (this.execute === executeGh) await browserLogin(this.onSignIn);
			else await this.execute(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "public_repo,workflow"]);
			await this.execute(["auth", "setup-git", "--hostname", "github.com"]);
		} catch (error) {
			throw new Error(`GitHub connection did not complete. ${friendlyGitHubError(error)}`);
		}
		const connection = await this.getConnection();
		if (!connection.connected) throw new Error(connection.reason || "GitHub connection did not complete.");
		return connection;
	}

	async listRepositories(limit = 5): Promise<RepositorySummary[]> {
		const data = await this.api("GET", `user/repos?sort=updated&per_page=${Math.max(1, Math.min(limit, 20))}`) as ApiRepository[];
		return data.map(repositorySummary);
	}

	async getRepository(owner: string, repo: string): Promise<RepositorySummary | undefined> {
		try { return repositorySummary(await this.api("GET", `repos/${segment(owner)}/${segment(repo)}`) as ApiRepository); }
		catch (error) { if (/404|not found/i.test(String(error))) return undefined; throw error; }
	}

	async createRepository(name: string): Promise<RepositorySummary> {
		const repository = await this.api("POST", "user/repos", {
			name,
			private: false,
			auto_init: false,
			description: "Published with Pi Student",
		}) as ApiRepository;
		return repositorySummary(repository);
	}

	async configurePages(owner: string, repo: string, branch: string, deploymentType: "branch" | "github-actions"): Promise<void> {
		const route = `repos/${segment(owner)}/${segment(repo)}/pages`;
		const body = deploymentType === "branch" ? { build_type: "legacy", source: { branch, path: "/" } } : { build_type: "workflow" };
		try {
			await this.api("POST", route, body);
		} catch (error) {
			if (!/already exists|409|422/i.test(String(error))) throw new Error(friendlyGitHubError(error));
			await this.api("PUT", route, body);
		}
	}

	async getPagesStatus(owner: string, repo: string): Promise<GitHubPagesStatus> {
		const route = `repos/${segment(owner)}/${segment(repo)}/pages`;
		try {
			const pages = await this.api("GET", route) as { html_url?: string; status?: string };
			try {
				const actions = await this.api("GET", `repos/${segment(owner)}/${segment(repo)}/actions/workflows/pi-pages.yml/runs?per_page=1`) as {
					workflow_runs?: Array<{ id?: number; status?: string; conclusion?: string; head_sha?: string; html_url?: string }>;
				};
				const run = actions.workflow_runs?.[0];
				if (run) {
					if (run.status !== "completed") return { status: run.status === "queued" ? "queued" : "building", url: pages.html_url, commit: run.head_sha };
					if (run.conclusion === "success") return { status: "built", url: pages.html_url, commit: run.head_sha };
					let failedStep: string | undefined;
					try {
						const jobs = await this.api("GET", `repos/${segment(owner)}/${segment(repo)}/actions/runs/${run.id}/jobs`) as { jobs?: Array<{ steps?: Array<{ name?: string; conclusion?: string }> }> };
						failedStep = jobs.jobs?.flatMap(job => job.steps ?? []).find(step => step.conclusion === "failure")?.name;
					} catch { /* The run link still gives the student a useful next step. */ }
					return { status: "errored", url: pages.html_url, commit: run.head_sha, error: `${failedStep ? `The “${failedStep}” step failed. ` : "The GitHub Actions build failed. "}${run.html_url ?? ""}`.trim() };
				}
			} catch (error) { if (!isNotFound(error)) throw error; /* A branch deployment has no Pi workflow. */ }
			let build: { status?: string; commit?: string; error?: { message?: string } } | undefined;
			try { build = await this.api("GET", `${route}/builds/latest`) as typeof build; } catch (error) { if (!isNotFound(error)) throw error; /* Actions deployments may not expose a legacy Pages build. */ }
			const raw = build?.status ?? pages.status ?? "unknown";
			return {
				status: raw === "built" ? "built" : raw === "errored" ? "errored" : raw === "building" || raw === "queued" ? raw : "unknown",
				url: pages.html_url,
				commit: build?.commit,
				error: build?.error?.message,
			};
		} catch (error) {
			if (/404|not found/i.test(String(error))) return { status: "unknown" };
			throw new Error(friendlyGitHubError(error));
		}
	}

	private async api(method: string, route: string, body?: unknown): Promise<unknown> {
		const args = ["api", `/${route}`, "--method", method, "--header", "Accept: application/vnd.github+json", "--header", "X-GitHub-Api-Version: 2022-11-28"];
		if (body !== undefined) args.push("--input", "-");
		const output = body === undefined ? await this.execute(args) : await executeGhWithInput(args, JSON.stringify(body), this.execute);
		return output.trim() ? JSON.parse(output) : {};
	}
}

interface ApiRepository {
	name?: string;
	full_name?: string;
	html_url?: string;
	private?: boolean;
	default_branch?: string;
	updated_at?: string;
	owner?: { login?: string };
}

function repositorySummary(repository: ApiRepository): RepositorySummary {
	const owner = repository.owner?.login ?? repository.full_name?.split("/")[0] ?? "";
	const name = repository.name ?? repository.full_name?.split("/")[1] ?? "";
	return {
		owner,
		name,
		fullName: repository.full_name ?? `${owner}/${name}`,
		url: repository.html_url ?? `https://github.com/${owner}/${name}`,
		visibility: repository.private ? "private" : "public",
		defaultBranch: repository.default_branch ?? "main",
		updatedAt: repository.updated_at,
	};
}

async function executeGh(args: string[]): Promise<string> {
	try {
		const result = await execFileAsync(await githubExecutable(), args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: process.env });
		return result.stdout;
	} catch (error) {
		throw new Error(commandError(error));
	}
}

async function executeGhWithInput(args: string[], input: string, fallback: GitHubCommandExecutor): Promise<string> {
	// Tests inject a command executor and receive the request body as an
	// explicit marker. The production path pipes JSON so it never appears in
	// shell command strings or process listings.
	if (fallback !== executeGh) return fallback([...args, "--pi-json-input", input]);
	const binary = await githubExecutable();
	return new Promise((resolve, reject) => {
		const child = execFile(binary, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
			if (error) reject(new Error(String(stderr || error.message).trim())); else resolve(stdout);
		});
		child.stdin?.end(input);
	});
}

function commandError(error: unknown): string {
	if (error && typeof error === "object") {
		const candidate = error as { code?: unknown; stderr?: unknown; message?: unknown };
		if (candidate.code === "ENOENT") return "Select Connect to sign in to GitHub in your browser.";
		return String(candidate.stderr || candidate.message || "GitHub command failed").trim();
	}
	return String(error);
}

function friendlyGitHubError(error: unknown): string {
	const message = String(error instanceof Error ? error.message : error).replace(/gh[opsu]_[A-Za-z0-9_]+/g, "[redacted]").slice(0, 700);
	if (/rate limit/i.test(message)) return "GitHub's API rate limit was reached. Wait a little, then publish again.";
	if (/401|bad credentials|authentication/i.test(message)) return "GitHub authorization is missing or expired. Select Connect to sign in again.";
	if (/403|permission|forbidden/i.test(message)) return "GitHub did not grant the permission needed for this action. Reconnect GitHub and approve repository and Pages access.";
	return message;
}

function segment(value: string): string {
	if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("GitHub owner or repository name contains unsupported characters.");
	return encodeURIComponent(value);
}

function isNotFound(error: unknown): boolean { return /404|not found/i.test(String(error)); }
