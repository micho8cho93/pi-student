import path from "node:path";
import { GitRunner } from "@pi-student/publishing/git-runner";
import { PublishingMetadataStore } from "@pi-student/publishing/metadata-store";
import type { GitHubClient, ProjectPublishingMetadata, RepositorySummary } from "@pi-student/publishing/types";
import { parseGitHubRemote } from "@pi-student/publishing/publishing-service";

export interface EcosystemState {
	environment?: {
		status: string;
		provider: string;
		message?: string;
	};
	github: {
		connected: boolean;
		username?: string;
		reason?: string;
		currentRepository?: ProjectPublishingMetadata["github"];
		branch?: string;
		changedFiles: number;
		ahead: number;
		behind: number;
		repositories: RepositorySummary[];
	};
	deployments: ProjectPublishingMetadata[];
	currentProject?: ProjectPublishingMetadata;
}

export async function readEcosystemState(projectPath: string, github: GitHubClient, metadata = new PublishingMetadataStore(), git = new GitRunner()): Promise<EcosystemState> {
	const [connection, currentProject, deployments] = await Promise.all([
		github.getConnection(),
		metadata.read(projectPath),
		metadata.list(),
	]);
	let repositories: RepositorySummary[] = [];
	if (connection.connected) {
		try { repositories = await github.listRepositories(5); } catch { /* Keep local project state useful if GitHub is temporarily unavailable. */ }
	}
	let branch: string | undefined;
	let changedFiles = 0;
	let ahead = 0;
	let behind = 0;
	let currentRepository = currentProject?.github;
	if (await git.isRepository(projectPath) && path.resolve(await git.root(projectPath) ?? "") === path.resolve(projectPath)) {
		branch = (await git.run(projectPath, ["symbolic-ref", "--short", "HEAD"], true)).stdout.trim() || undefined;
		const status = (await git.run(projectPath, ["status", "--porcelain"], true)).stdout.trim();
		changedFiles = status ? status.split("\n").length : 0;
		const divergence = (await git.run(projectPath, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], true)).stdout.trim().split(/\s+/).map(Number);
		behind = Number.isFinite(divergence[0]) ? divergence[0]! : 0;
		ahead = Number.isFinite(divergence[1]) ? divergence[1]! : 0;
		if (!currentRepository) {
			const remote = (await git.run(projectPath, ["remote", "get-url", "origin"], true)).stdout.trim();
			const parsed = remote ? parseGitHubRemote(remote) : undefined;
			if (parsed) currentRepository = { owner: parsed.owner, repo: parsed.repo, branch: branch ?? "main", repositoryUrl: `https://github.com/${parsed.owner}/${parsed.repo}` };
		}
	}
	return {
		github: {
			...connection,
			currentRepository,
			branch: branch ?? currentProject?.github?.branch,
			changedFiles,
			ahead,
			behind,
			repositories,
		},
		deployments: deployments.filter(item => item.deployment),
		currentProject,
	};
}
