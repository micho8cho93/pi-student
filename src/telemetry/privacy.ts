/** Defense in depth for student-entered learning evidence. */
export function redactSensitiveText(value: string): string {
	return value
		.replace(/\b(sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|AIza[a-z0-9_-]{20,})\b/gi, "[redacted credential]")
		.replace(/\b(bearer\s+)[a-z0-9._~+\/-]+=*/gi, "$1[redacted]")
		.replace(/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}

