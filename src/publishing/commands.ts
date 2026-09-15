import { createInterface } from "node:readline/promises";
import process from "node:process";
import { GhGitHubClient } from "./github-client.js";
import { readEcosystemState } from "./ecosystem-state.js";
import { PublishingService } from "./publishing-service.js";
import type { PublishProgress } from "./types.js";

export async function runPublishingCommand(argv: string[], cwd = process.cwd()): Promise<boolean> {
	const [command, subcommand, ...rest] = argv;
	if (command !== "publish" && command !== "github" && command !== "deployments") return false;
	const github = new GhGitHubClient();
	if (command === "github") {
		if (!subcommand || subcommand === "status") {
			const connection = await github.getConnection();
			process.stdout.write(connection.connected ? `GitHub\n\n✓ Connected as @${connection.username}\n` : `GitHub\n\nNot connected\n\nRun:\n  pi-student github connect\n`);
			return true;
		}
		if (subcommand === "connect") {
			process.stdout.write("Connecting GitHub in your browser...\n");
			const connection = await github.connect();
			process.stdout.write(`\n✓ Connected as @${connection.username}\n`);
			return true;
		}
		if (subcommand === "repositories") {
			const repositories = await github.listRepositories(20);
			process.stdout.write(`GitHub repositories\n\n${repositories.length ? repositories.map(repo => `  ${repo.fullName}  ${repo.visibility}`).join("\n") : "  No repositories yet."}\n`);
			return true;
		}
		throw new Error(`Unknown GitHub command: ${subcommand}`);
	}
	if (command === "deployments") {
		const state = await readEcosystemState(cwd, github);
		process.stdout.write(`Deployments\n\n${state.deployments.length ? state.deployments.map(item => `  ${symbol(item.deployment!.status)} ${item.projectName}\n    ${item.deployment!.url ?? item.deployment!.lastError ?? item.deployment!.status}`).join("\n\n") : "  No published projects yet."}\n`);
		return true;
	}

	const flags = [subcommand, ...rest].filter(Boolean) as string[];
	const unknown = flags.find(flag => flag !== "--yes");
	if (unknown) throw new Error(`Unknown publish option: ${unknown}`);
	const connection = await github.getConnection();
	if (!connection.connected) {
		const connectNow = flags.includes("--yes") || await confirm("GitHub must be connected before publishing.", "Connect GitHub now?");
		if (!connectNow) throw new Error("Publishing cancelled. Connect GitHub with `pi-student github connect` when you are ready.");
		process.stdout.write("Connecting GitHub in your browser...\n");
		await github.connect();
	}
	process.stdout.write(`Publishing ${cwd.split(/[\\/]/).pop() || "project"}...\n\n`);
	const service = new PublishingService({
		github,
		onProgress: progress => printProgress(progress),
		confirmPublic: async message => flags.includes("--yes") || confirm(message),
	});
	const result = await service.publish(cwd);
	process.stdout.write(`\nLive site:\n${result.url}\n\nRepository:\n${result.repositoryUrl}\n`);
	return true;
}

function printProgress(progress: PublishProgress): void {
	if (progress.status === "started") process.stdout.write(`○ ${progress.message}\n`);
	else if (progress.status === "complete") process.stdout.write(`✓ ${progress.message}\n`);
	else if (progress.status === "info") process.stdout.write(`· ${progress.message}\n`);
}

async function confirm(message: string, question = "Continue?"): Promise<boolean> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${message}\n\nRun again with --yes after reviewing this warning.`);
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	try { return !/^n(?:o)?$/i.test((await terminal.question(`${message}\n\n${question} [Y/n] `)).trim()); }
	finally { terminal.close(); }
}

function symbol(status: string): string { return status === "published" ? "✓" : status === "failed" ? "✕" : "○"; }
