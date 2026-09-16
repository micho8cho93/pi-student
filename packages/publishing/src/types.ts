export type ProjectKind = "static" | "vite" | "react" | "astro" | "svelte" | "unsupported";

export type DeploymentStatus = "preparing" | "building" | "deploying" | "published" | "failed";

export interface ProjectDetection {
	kind: ProjectKind;
	label: string;
	deploymentType: "branch" | "github-actions";
	buildCommand?: string;
	outputDirectory?: string;
	reason?: string;
}

export interface GitHubConnection {
	connected: boolean;
	username?: string;
	reason?: string;
}

export interface RepositorySummary {
	owner: string;
	name: string;
	fullName: string;
	url: string;
	visibility: "public" | "private";
	defaultBranch: string;
	updatedAt?: string;
}

export interface DeploymentHistoryEntry {
	status: "published" | "failed";
	commit?: string;
	at: string;
	message?: string;
}

export interface ProjectPublishingMetadata {
	version: 1;
	projectPath: string;
	projectName: string;
	github?: {
		owner: string;
		repo: string;
		branch: string;
		repositoryUrl: string;
		publicConsentAt?: string;
	};
	deployment?: {
		provider: string;
		providerLabel: string;
		status: DeploymentStatus;
		url?: string;
		repositoryUrl: string;
		branch: string;
		deploymentType: "branch" | "github-actions";
		managedWorkflow?: boolean;
		lastPublishedAt?: string;
		lastError?: string;
		history: DeploymentHistoryEntry[];
	};
}

export interface PublishProgress {
	step: "connection" | "project" | "repository" | "git" | "push" | "deployment";
	status: "started" | "complete" | "failed" | "info";
	message: string;
}

export interface PublishResult {
	url: string;
	repositoryUrl: string;
	owner: string;
	repository: string;
	branch: string;
	commit?: string;
	project: ProjectDetection;
}

export interface GitHubPagesStatus {
	status: "queued" | "building" | "built" | "errored" | "unknown";
	url?: string;
	commit?: string;
	error?: string;
}

export interface GitHubClient {
	getConnection(): Promise<GitHubConnection>;
	connect(): Promise<GitHubConnection>;
	listRepositories(limit?: number): Promise<RepositorySummary[]>;
	getRepository(owner: string, repo: string): Promise<RepositorySummary | undefined>;
	createRepository(name: string): Promise<RepositorySummary>;
	configurePages(owner: string, repo: string, branch: string, deploymentType: "branch" | "github-actions"): Promise<void>;
	removePages(owner: string, repo: string): Promise<void>;
	getPagesStatus(owner: string, repo: string): Promise<GitHubPagesStatus>;
}

export interface DeploymentProvider {
	readonly id: string;
	readonly label: string;
	deploy(input: { owner: string; repo: string; branch: string; deploymentType: "branch" | "github-actions" }): Promise<void>;
	update(input: { owner: string; repo: string; branch: string; deploymentType: "branch" | "github-actions" }): Promise<void>;
	getStatus(owner: string, repo: string): Promise<GitHubPagesStatus>;
	getDeploymentUrl(owner: string, repo: string): Promise<string | undefined>;
	remove(owner: string, repo: string): Promise<void>;
}

/** @deprecated Use DeploymentProvider. */
export type HostingProvider = DeploymentProvider;
