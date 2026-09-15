import type { GitHubClient, GitHubPagesStatus, HostingProvider } from "./types.js";

export class GitHubPagesProvider implements HostingProvider {
	readonly id = "github-pages";
	readonly label = "GitHub Pages";

	constructor(private readonly github: GitHubClient) {}

	publish(input: { owner: string; repo: string; branch: string; deploymentType: "branch" | "github-actions" }): Promise<void> {
		return this.github.configurePages(input.owner, input.repo, input.branch, input.deploymentType);
	}

	update(input: { owner: string; repo: string; branch: string; deploymentType: "branch" | "github-actions" }): Promise<void> {
		return this.publish(input);
	}

	getStatus(owner: string, repo: string): Promise<GitHubPagesStatus> { return this.github.getPagesStatus(owner, repo); }
	async getDeploymentUrl(owner: string, repo: string): Promise<string | undefined> { return (await this.getStatus(owner, repo)).url; }
	async remove(): Promise<void> { throw new Error("Removing deployments is not available in this release."); }
}
