import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitRunner } from "./git-runner.js";

const DEFAULT_IGNORE = [".env", ".env.*", "!.env.example", "node_modules/", "dist/", "build/", "*.pem", "*.key"];
const FORBIDDEN_FILE = /(^|\/)(\.env(?:\..+)?|[^/]+\.(?:pem|key|p12|pfx))$/i;
const SECRET_PATTERNS: Array<[string, RegExp]> = [
	["a private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
	["a GitHub token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/],
	["an AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
	["a credential assignment", /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i],
];

export async function ensureMinimalGitignore(projectPath: string): Promise<boolean> {
	const ignorePath = path.join(projectPath, ".gitignore");
	try { await access(ignorePath); return false; } catch {
		await writeFile(ignorePath, `${DEFAULT_IGNORE.join("\n")}\n`);
		return true;
	}
}

export async function scanPublishableFiles(projectPath: string, git: GitRunner): Promise<string[]> {
	const listed = await git.run(projectPath, ["ls-files", "--cached", "--others", "--exclude-standard"]);
	const files = listed.stdout.split("\n").map(value => value.trim()).filter(Boolean);
	const issues: string[] = [];
	for (const relative of files) {
		if (FORBIDDEN_FILE.test(relative)) {
			issues.push(`${relative} is a sensitive file and must be added to .gitignore.`);
			continue;
		}
		const absolute = path.resolve(projectPath, relative);
		if (!isInside(projectPath, absolute)) {
			issues.push(`${relative} points outside this project.`);
			continue;
		}
		let contents: string;
		try {
			contents = await readFile(absolute, { encoding: "utf8" });
		} catch { continue; }
		if (contents.length > 1_000_000) continue;
		for (const [label, pattern] of SECRET_PATTERNS) {
			if (pattern.test(contents)) {
				issues.push(`${relative} appears to contain ${label}.`);
				break;
			}
		}
	}
	return issues;
}

export function sanitizeRepositoryName(value: string): string {
	const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-").replace(/^[._-]+|[._-]+$/g, "").replace(/-{2,}/g, "-").slice(0, 90);
	return normalized || "pi-student-project";
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
