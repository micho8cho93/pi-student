import path from "node:path";
import { responsibilityForTerminalCommand } from "../education/learning-boundary.js";

export type TerminalCommandClass = "inspection" | "autonomous" | "student-checkpoint" | "approval-required" | "unknown";

const INSPECTION_COMMANDS = new Set(["pwd", "ls", "find", "grep", "rg", "cat", "head", "tail", "git"]);
const STUDENT_CHECKPOINT_PATTERNS = [
	/\b(vercel|netlify|wrangler|flyctl|railway)\b.*\b(deploy|publish|production)\b/i,
];
const APPROVAL_PATTERNS = [
	/\brm\s+-[^\s]*r[^\s]*\b/i,
	/\bsudo\b/i,
	/\bgit\s+(?:reset\s+--hard|clean\b.*-f|push\b.*(?:--force|-f)|branch\s+-[dD])\b/i,
	/\b(chmod|chown)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+(?:install|add)\b.*\s-g(?:lobal)?\b/i,
	/\b(apt|brew|pacman|dnf)\s+(?:install|remove|upgrade|update)\b/i,
	/\b(curl|wget)\b.*\|\s*(?:sh|bash)\b/i,
	/\b(?:\.env|auth\.json|credentials|secrets?)\b.*(?:>|>>|tee|write)/i,
];

export function classifyTerminalCommand(command: string, cwd = process.cwd()): TerminalCommandClass {
	const trimmed = command.trim();
	if (!trimmed) return "unknown";
	if (hasShellSyntax(trimmed)) return "approval-required";
	if (APPROVAL_PATTERNS.some((pattern) => pattern.test(trimmed))) return "approval-required";
	if (responsibilityForTerminalCommand(trimmed)?.responsibility === "student") return "student-checkpoint";
	if (STUDENT_CHECKPOINT_PATTERNS.some((pattern) => pattern.test(trimmed))) return "student-checkpoint";
	if (/^git\s+(status|diff|log|show)\b/i.test(trimmed)) return "autonomous";
	if (isInspectionCommand(trimmed)) return "inspection";
	if (containsOutsideWorkspacePath(trimmed, cwd)) return "approval-required";
	if (/\b(npm|pnpm|yarn|bun)\s+(install|ci|test|run\s+(?:build|lint|dev|start))\b/i.test(trimmed)) return "autonomous";
	if (/\b(git\s+(status|diff|log|show)|(?:npm|pnpm|yarn|bun)\s+(test|run\s+(?:build|lint)))\b/i.test(trimmed)) return "autonomous";
	if (/\b(mkdir|touch|cp|mv)\b/i.test(trimmed) || /(?:>|>>)/.test(trimmed)) return "autonomous";
	if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start)\b/i.test(trimmed)) return "autonomous";
	return "unknown";
}

export function isSafeInspectionCommand(command: string, cwd = process.cwd()): boolean {
	return !hasShellSyntax(command) && !containsOutsideWorkspacePath(command, cwd) && isInspectionCommand(command.trim())
		&& !APPROVAL_PATTERNS.some(pattern => pattern.test(command));
}

export function isSafeVerificationCommand(command: string, cwd = process.cwd()): boolean {
	return !hasShellSyntax(command) && !containsOutsideWorkspacePath(command, cwd) &&
		(isSafeInspectionCommand(command, cwd) || /^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|build|lint))\b/i.test(command.trim()));
}

function hasShellSyntax(command: string): boolean {
	return /[|;&`$()<>\n\r\\]/.test(command);
}

export function isWorkspacePath(candidate: string, cwd: string): boolean {
	return isInside(path.resolve(cwd, candidate), cwd);
}

function isInspectionCommand(command: string): boolean {
	if (hasShellSyntax(command)) return false;
	const [program, ...args] = command.split(/\s+/u).filter(Boolean);
	if (!INSPECTION_COMMANDS.has(program)) return false;
	if (program === "git") return /^(status|diff|log|show)$/.test(args[0] ?? "") &&
		!args.some(arg => /^--(output|ext-diff|textconv)(=|$)/.test(arg));
	if (program === "find") return !args.some(arg => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg));
	if (program === "rg") return !args.some(arg => /^--(pre|hostname-bin)(=|$)/.test(arg));
	return true;
}

function containsOutsideWorkspacePath(command: string, cwd: string): boolean {
	const absolutePaths = command.match(/(?:^|\s)(\/[^\s>;&|]+)/g) ?? [];
	return absolutePaths.some((match) => {
		const candidate = match.trim().replace(/["']/g, "");
		return candidate !== "/" && !isInside(candidate, cwd);
	});
}

function isInside(candidate: string, cwd: string): boolean {
	const relative = path.relative(cwd, path.resolve(candidate));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
