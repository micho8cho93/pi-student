import type { DeploymentProvider, GitHubClient, GitHubPagesStatus } from "./types.js";

export class GitHubPagesProvider implements DeploymentProvider {
	readonly id = "github-pages";
	readonly label = "GitHub Pages";

	constructor(private readonly github: GitHubClient) {}

	deploy(input: { owner: string; repo: string; branch: string; deploymentType: "branch" | "github-actions" }): Promise<void> {
		return this.github.configurePages(input.owner, input.repo, input.branch, input.deploymentType);
	}

	update(input: { owner: string; repo: string; branch: string; deploymentType: "branch" | "github-actions" }): Promise<void> {
		return this.deploy(input);
	}

	getStatus(owner: string, repo: string): Promise<GitHubPagesStatus> { return this.github.getPagesStatus(owner, repo); }
	async getDeploymentUrl(owner: string, repo: string): Promise<string | undefined> { return (await this.getStatus(owner, repo)).url; }
	remove(owner: string, repo: string): Promise<void> { return this.github.removePages(owner, repo); }
}
