import { access, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectProjectType } from "./project-detection.js";
import { GitRunner } from "./git-runner.js";
import { GitHubPagesProvider } from "./github-pages-provider.js";
import { PublishingMetadataStore } from "./metadata-store.js";
import { ensureMinimalGitignore, sanitizeRepositoryName, scanPublishableFiles } from "./security.js";
import { ensurePagesWorkflow } from "./workflow.js";
import type { GitHubClient, HostingProvider, ProjectPublishingMetadata, PublishProgress, PublishResult, RepositorySummary } from "./types.js";

export interface PublishingServiceOptions {
	github: GitHubClient;
	git?: GitRunner;
	metadata?: PublishingMetadataStore;
	provider?: HostingProvider;
	onProgress?: (progress: PublishProgress) => void;
	confirmPublic?: (message: string) => Promise<boolean>;
	wait?: (milliseconds: number) => Promise<void>;
	maxStatusChecks?: number;
}

export class PublishingService {
	private readonly git: GitRunner;
	private readonly metadata: PublishingMetadataStore;
	private readonly provider: HostingProvider;
	private readonly progress: (progress: PublishProgress) => void;
	private readonly wait: (milliseconds: number) => Promise<void>;
	private readonly maxStatusChecks: number;

	constructor(private readonly options: PublishingServiceOptions) {
		this.git = options.git ?? new GitRunner();
		this.metadata = options.metadata ?? new PublishingMetadataStore();
		this.provider = options.provider ?? new GitHubPagesProvider(options.github);
		this.progress = options.onProgress ?? (() => {});
		this.wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
		this.maxStatusChecks = options.maxStatusChecks ?? 40;
	}

	async publish(requestedPath: string): Promise<PublishResult> {
		const projectPath = await realpath(requestedPath);
		const projectName = path.basename(projectPath);
		let metadata = await this.metadata.read(projectPath) ?? { version: 1, projectPath, projectName } satisfies ProjectPublishingMetadata;
		let repository: RepositorySummary | undefined;
		let commit: string | undefined;
		const updatingDeployment = Boolean(metadata.deployment);
		let publicConsentAt = metadata.github?.publicConsentAt;
		try {
			this.progress({ step: "connection", status: "started", message: "Checking GitHub connection" });
			const connection = await this.options.github.getConnection();
			if (!connection.connected || !connection.username) throw new Error("GitHub must be connected before publishing. Run `pi-student github connect`.");
			this.progress({ step: "connection", status: "complete", message: `GitHub connected as @${connection.username}` });

			const project = await detectProjectType(projectPath);
			if (project.kind === "unsupported") throw new Error(project.reason ?? "This project cannot be published yet.");
			this.progress({ step: "project", status: "complete", message: `Project detected: ${project.label}` });

			const gitState = await this.prepareGitRepository(projectPath, connection.username);
			const workflow = await ensurePagesWorkflow(projectPath, project, gitState.branch);
			if (project.deploymentType === "branch") await ensureNoJekyll(projectPath);
			const issues = await scanPublishableFiles(projectPath, this.git);
			if (issues.length) throw new Error(`Pi found files that may contain secrets and did not publish:\n${issues.map(issue => `- ${issue}`).join("\n")}`);
			const remoteRepository = gitState.remote ? parseGitHubRemote(gitState.remote) : undefined;
			if (gitState.remote && !remoteRepository) throw new Error("The existing origin remote is not a GitHub repository, so Pi will not replace it.");
			if (remoteRepository && metadata.github && (remoteRepository.owner !== metadata.github.owner || remoteRepository.repo !== metadata.github.repo)) {
				throw new Error("The saved GitHub repository does not match the project's origin remote. Pi stopped without changing either repository.");
			}

			if (remoteRepository) {
				repository = await this.options.github.getRepository(remoteRepository.owner, remoteRepository.repo);
				if (!repository) throw new Error(`The GitHub repository ${remoteRepository.owner}/${remoteRepository.repo} is unavailable. Check its access or reconnect GitHub.`);
				this.progress({ step: "repository", status: "complete", message: `Using repository ${repository.fullName}` });
			} else if (metadata.github) {
				repository = await this.options.github.getRepository(metadata.github.owner, metadata.github.repo);
				if (!repository) throw new Error(`The saved GitHub repository ${metadata.github.owner}/${metadata.github.repo} is unavailable.`);
			} else {
				const consented = await this.options.confirmPublic?.("Publishing this project will create a public GitHub repository. Anyone will be able to view the source code and published site.");
				if (!consented) throw new Error("Publishing cancelled before creating a public repository.");
				repository = await this.createUniqueRepository(projectName);
				publicConsentAt = new Date().toISOString();
				this.progress({ step: "repository", status: "complete", message: `Created public repository ${repository.fullName}` });
			}

			const branch = gitState.branch;
			const repositoryUrl = repository.url;
			metadata = {
				...metadata,
				github: {
					owner: repository.owner,
					repo: repository.name,
					branch,
					repositoryUrl,
					publicConsentAt,
				},
				deployment: {
					...metadata.deployment,
					provider: this.provider.id,
					providerLabel: this.provider.label,
					status: "preparing",
					repositoryUrl,
					branch,
					deploymentType: project.deploymentType,
					history: metadata.deployment?.history ?? [],
				},
			};
			await this.metadata.write(projectPath, metadata);

			await this.git.run(projectPath, ["add", "--all"]);
			const changes = (await this.git.run(projectPath, ["status", "--porcelain"])).stdout.trim();
			const hasCommit = Boolean((await this.git.run(projectPath, ["rev-parse", "--verify", "HEAD"], true)).stdout.trim());
			if (changes || !hasCommit) {
				await this.git.run(projectPath, ["commit", "-m", hasCommit ? "Publish update from Pi" : "Initial publish from Pi"]);
				this.progress({ step: "git", status: "complete", message: changes ? `${changes.split("\n").length} files changed; created commit` : "Created initial commit" });
			} else {
				this.progress({ step: "git", status: "info", message: "No file changes; checking the current deployment" });
			}
			commit = (await this.git.run(projectPath, ["rev-parse", "--short", "HEAD"])).stdout.trim();

			await this.ensureOrigin(projectPath, repository);
			await this.git.run(projectPath, ["push", "--set-upstream", "origin", branch]);
			this.progress({ step: "push", status: "complete", message: `Pushed ${branch} branch` });

			metadata.deployment = { ...metadata.deployment!, status: "deploying", managedWorkflow: workflow.managed };
			await this.metadata.write(projectPath, metadata);
			const deploymentInput = { owner: repository.owner, repo: repository.name, branch, deploymentType: project.deploymentType };
			if (updatingDeployment) await this.provider.update(deploymentInput);
			else await this.provider.publish(deploymentInput);
			this.progress({ step: "deployment", status: "started", message: `Deploying with ${this.provider.label}` });
			const url = await this.waitForDeployment(repository.owner, repository.name, commit);
			const now = new Date().toISOString();
			metadata.deployment = {
				...metadata.deployment,
				status: "published",
				url,
				lastPublishedAt: now,
				lastError: undefined,
				history: [{ status: "published" as const, commit, at: now }, ...metadata.deployment.history].slice(0, 20),
			};
			await this.metadata.write(projectPath, metadata);
			this.progress({ step: "deployment", status: "complete", message: "Deployment complete" });
			return { url, repositoryUrl, owner: repository.owner, repository: repository.name, branch, commit, project };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (metadata.deployment) {
				const now = new Date().toISOString();
				metadata.deployment = { ...metadata.deployment, status: "failed", lastError: message.slice(0, 1000), history: [{ status: "failed" as const, commit, at: now, message: message.slice(0, 500) }, ...metadata.deployment.history].slice(0, 20) };
				await this.metadata.write(projectPath, metadata).catch(() => undefined);
			}
			this.progress({ step: "deployment", status: "failed", message });
			throw error;
		}
	}

	private async prepareGitRepository(projectPath: string, username: string): Promise<{ branch: string; remote?: string }> {
		const isRepository = await this.git.isRepository(projectPath);
		if (isRepository) {
			const root = await this.git.root(projectPath);
			if (!root || path.resolve(root) !== path.resolve(projectPath)) throw new Error("This folder is inside a larger Git repository. Open the repository root before publishing so Pi cannot include unrelated files.");
		} else {
			await this.git.run(projectPath, ["init"]);
			await this.git.run(projectPath, ["branch", "-M", "main"]);
			this.progress({ step: "git", status: "complete", message: "Created Git repository" });
		}
		await ensureMinimalGitignore(projectPath);
		if (!(await this.git.run(projectPath, ["config", "--get", "user.name"], true)).stdout.trim()) {
			await this.git.run(projectPath, ["config", "user.name", username]);
		}
		if (!(await this.git.run(projectPath, ["config", "--get", "user.email"], true)).stdout.trim()) {
			await this.git.run(projectPath, ["config", "user.email", `${username}@users.noreply.github.com`]);
		}
		const conflicts = (await this.git.run(projectPath, ["diff", "--name-only", "--diff-filter=U"], true)).stdout.trim();
		if (conflicts) throw new Error(`This project has an unfinished Git merge conflict. Resolve these files before publishing:\n${conflicts}`);
		let branch = (await this.git.run(projectPath, ["symbolic-ref", "--short", "HEAD"], true)).stdout.trim();
		if (!branch) {
			if (isRepository) throw new Error("This repository is in detached HEAD state. Switch to a branch before publishing; Pi will not move existing history automatically.");
			await this.git.run(projectPath, ["branch", "-M", "main"]);
			branch = "main";
		}
		if (!/^[A-Za-z0-9._\/-]+$/.test(branch)) throw new Error("The current Git branch name is not safe to publish.");
		const remote = (await this.git.run(projectPath, ["remote", "get-url", "origin"], true)).stdout.trim() || undefined;
		return { branch, remote };
	}

	private async createUniqueRepository(projectName: string): Promise<RepositorySummary> {
		const base = sanitizeRepositoryName(projectName);
		for (let suffix = 0; suffix < 50; suffix += 1) {
			const name = suffix === 0 ? base : `${base}-${suffix + 1}`;
			const connection = await this.options.github.getConnection();
			if (!connection.username) throw new Error("GitHub connection was lost before the repository could be created.");
			if (!await this.options.github.getRepository(connection.username, name)) return this.options.github.createRepository(name);
		}
		throw new Error("Pi could not find an available repository name. Rename the project and publish again.");
	}

	private async ensureOrigin(projectPath: string, repository: RepositorySummary): Promise<void> {
		const desired = `https://github.com/${repository.owner}/${repository.name}.git`;
		const existing = (await this.git.run(projectPath, ["remote", "get-url", "origin"], true)).stdout.trim();
		if (!existing) await this.git.run(projectPath, ["remote", "add", "origin", desired]);
		else {
			const parsed = parseGitHubRemote(existing);
			if (!parsed || parsed.owner !== repository.owner || parsed.repo !== repository.name) throw new Error("The origin remote points to a different repository. Pi will not replace it automatically.");
		}
	}

	private async waitForDeployment(owner: string, repo: string, expectedCommit?: string): Promise<string> {
		for (let attempt = 0; attempt < this.maxStatusChecks; attempt += 1) {
			const status = await this.provider.getStatus(owner, repo);
			const currentBuild = !expectedCommit || !status.commit || status.commit.startsWith(expectedCommit) || expectedCommit.startsWith(status.commit);
			if (currentBuild && status.status === "built" && status.url) return status.url;
			if (currentBuild && status.status === "errored") throw new Error(`GitHub Pages could not build this site.${status.error ? ` ${status.error}` : " Open the failed deployment in Pi for details."}`);
			if (attempt < this.maxStatusChecks - 1) await this.wait(3_000);
		}
		throw new Error("GitHub Pages did not finish before the publishing check timed out. The build may still be running; open Deployments or run `pi-student publish` again.");
	}
}

export function parseGitHubRemote(remote: string): { owner: string; repo: string } | undefined {
	const match = remote.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
	return match ? { owner: match[1]!, repo: match[2]! } : undefined;
}

async function ensureNoJekyll(projectPath: string): Promise<void> {
	const filePath = path.join(projectPath, ".nojekyll");
	try { await access(filePath); } catch { await writeFile(filePath, ""); }
}
