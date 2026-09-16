import type { Writable } from "node:stream";
import { DEFAULT_THEME, getTerminalPalette } from "./themes.js";

export interface TerminalTheme {
	readonly enabled: boolean;
	readonly accent: (text: string) => string;
	readonly border: (text: string) => string;
	readonly dim: (text: string) => string;
	readonly muted: (text: string) => string;
	readonly success: (text: string) => string;
	readonly warning: (text: string) => string;
	readonly error: (text: string) => string;
	readonly bold: (text: string) => string;
}

export function createTheme(output: NodeJS.WritableStream, name = DEFAULT_THEME): TerminalTheme {
	const enabled = Boolean((output as Writable & { isTTY?: boolean }).isTTY) && !process.env.NO_COLOR;
	const paint = (open: string) => (text: string) => (enabled ? `${open}${text}\x1b[0m` : text);
	const palette = getTerminalPalette(name);
	return {
		enabled,
		accent: paint(foreground(palette.accent)),
		border: paint(foreground(palette.muted)),
		dim: paint("\x1b[2m"),
		muted: paint(foreground(palette.muted)),
		success: paint(foreground(palette.success)),
		warning: paint(foreground(palette.warning)),
		error: paint(foreground(palette.error)),
		bold: paint("\x1b[1m"),
	};
}

function foreground(hex: string): string {
	const value = hex.slice(1);
	return `\x1b[38;2;${Number.parseInt(value.slice(0, 2), 16)};${Number.parseInt(value.slice(2, 4), 16)};${Number.parseInt(value.slice(4, 6), 16)}m`;
}

export interface PanelRow {
	label: string;
	value: string;
	tone?: "accent" | "success" | "warning" | "error" | "muted";
}

export function renderPanel(theme: TerminalTheme, title: string, rows: readonly PanelRow[]): string {
	const longest = Math.max(title.length + 4, ...rows.map(({ label, value }) => Math.max(10, label.length) + value.length + 3));
	const innerWidth = Math.max(42, Math.min(94, longest));
	const titleSegment = `─ ${title} `;
	const lines = [
		`${theme.border("╭")}${theme.accent(titleSegment)}${theme.border(`${"─".repeat(innerWidth - titleSegment.length)}╮`)}`,
	];
	for (const { label, value, tone = "muted" } of rows) {
		const prefix = `  ${label.padEnd(10)}`;
		const available = innerWidth - prefix.length - 1;
		const clipped = truncate(value, available);
		const padding = " ".repeat(Math.max(0, available - Array.from(clipped).length));
		lines.push(`${theme.border("│")}${theme.dim(prefix)}${theme[tone](clipped)}${padding} ${theme.border("│")}`);
	}
	lines.push(`${theme.border("╰")}${theme.border(`${"─".repeat(innerWidth)}╯`)}`);
	return lines.join("\n");
}

function truncate(value: string, width: number): string {
	const characters = Array.from(value);
	return characters.length <= width ? value : `${characters.slice(0, Math.max(0, width - 1)).join("")}…`;
}

export function renderWelcome(theme: TerminalTheme, cwd: string, provider: string, model: string): string {
	return `\n${renderPanel(theme, "Pi Student · guided coding workspace", [
		{ label: "project", value: cwd },
		{ label: "model", value: `${provider}/${model}` },
	])}\n\n`;
}

export function renderSetupHeader(theme: TerminalTheme): string {
	return `\n${renderPanel(theme, "Welcome to Pi Student", [
		{ label: "setup", value: "Connect a model provider once to start learning in this project." },
	])}\n`;
}

export function renderAssistantLabel(theme: TerminalTheme): string {
	return `\n${theme.accent("Pi")} ${theme.dim("· assistant")}\n`;
}

export function renderWorkNotesLabel(theme: TerminalTheme): string {
	return `\n${theme.accent("Work notes")} ${theme.dim("· reasoning")}\n`;
}

export function renderUserLabel(theme: TerminalTheme, message: string): string {
	return `\n${theme.bold("You")}\n${indent(message)}\n`;
}

export function indent(text: string, prefix = "  "): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

export function redactSecrets(text: string): string {
	return text
		.replace(/\bBearer\s+[^\s,)]+/gi, "Bearer [redacted]")
		.replace(/\b(sk-(?:ant|proj|live)?-[A-Za-z0-9_-]{8,})\b/g, "[redacted key]")
		.replace(/\b(api[_ -]?key|token|secret)\s*[:=]\s*[^\s,;)]+/gi, "$1=[redacted]");
}

export function formatProviderError(error: unknown, theme: TerminalTheme): string {
	const raw = redactSecrets(error instanceof Error ? error.message : String(error));
	if (process.env.PI_STUDENT_DEBUG === "1") {
		return `${theme.error("The model provider returned an error.")}\n${indent(formatProviderErrorMessage(raw))}\n${theme.dim(`Debug: ${raw}`)}`;
	}
	return `${theme.error("The model provider could not complete that request.")}\n${indent(formatProviderErrorMessage(raw))}\n${theme.dim("Try again, switch models, or check provider access in /settings.")}`;
}

export function formatProviderErrorMessage(error: string): string {
	const message = extractProviderMessage(error);
	const lower = `${error} ${message}`.toLowerCase();
	if (/429|quota|rate limit|resource exhausted|too many requests/.test(lower)) {
		return `${providerName(lower)} reached its temporary request limit. Try again shortly or switch models.`;
	}
	if (/thinking|reasoning|budget|unsupported.*(level|parameter)|invalid.*(level|reasoning)/.test(lower)) {
		return "This model does not support the configured reasoning level. Pi will use the nearest supported level when the model changes.";
	}
	if (/\b(502|503|504)\b|temporarily unavailable|overloaded|service unavailable|bad gateway/.test(lower)) {
		return "The provider is temporarily unavailable. Try again in a moment or switch to another configured model.";
	}
	if (/\b(401|403)\b|api key|authentication|unauthorized|forbidden|no credits|billing/.test(lower)) {
		return `Provider access was rejected${message ? `: ${message}` : ". Check the key, account access, and billing."}`;
	}
	if (message && !looksLikeJson(error) && message.length <= 240) return message;
	return "The provider returned an unexpected error. Enable PI_STUDENT_DEBUG=1 for the raw diagnostic.";
}

function extractProviderMessage(error: string): string {
	if (!looksLikeJson(error)) return error.trim();
	try {
		const parsed: unknown = JSON.parse(error);
		return findMessage(parsed) ?? "";
	} catch {
		return "";
	}
}

function findMessage(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	for (const key of ["message", "error", "detail", "statusText"]) {
		const found = findMessage(record[key]);
		if (found) return found;
	}
	return undefined;
}

function looksLikeJson(value: string): boolean {
	const trimmed = value.trim();
	return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function providerName(text: string): string {
	if (/gemini|google/.test(text)) return "Gemini";
	if (/anthropic|claude/.test(text)) return "Anthropic";
	if (/openai|gpt/.test(text)) return "OpenAI";
	return "This provider";
}
