import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CommandResult { stdout: string; stderr: string }
export type CommandExecutor = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

export class GitRunner {
	constructor(private readonly execute: CommandExecutor = executeCommand) {}

	async run(cwd: string, args: string[], allowFailure = false): Promise<CommandResult> {
		try {
			return await this.execute("git", args, cwd);
		} catch (error) {
			if (allowFailure) return { stdout: "", stderr: errorMessage(error) };
			throw new Error(studentGitError(args, errorMessage(error)));
		}
	}

	async isRepository(cwd: string): Promise<boolean> {
		const result = await this.run(cwd, ["rev-parse", "--is-inside-work-tree"], true);
		return result.stdout.trim() === "true";
	}

	async root(cwd: string): Promise<string | undefined> {
		const result = await this.run(cwd, ["rev-parse", "--show-toplevel"], true);
		return result.stdout.trim() || undefined;
	}
}

async function executeCommand(command: string, args: string[], cwd: string): Promise<CommandResult> {
	const result = await execFileAsync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return { stdout: result.stdout, stderr: result.stderr };
}

function errorMessage(error: unknown): string {
	if (error && typeof error === "object") {
		const candidate = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
		return String(candidate.stderr || candidate.stdout || candidate.message || "Git command failed").trim();
	}
	return String(error);
}

function studentGitError(args: string[], detail: string): string {
	const operation = args[0] === "push" ? "push changes to GitHub" : args[0] === "commit" ? "create the commit" : "prepare the Git repository";
	return `Pi could not ${operation}. ${detail.replace(/https?:\/\/[^\s@]+@/g, "https://").slice(0, 600)}`;
}
