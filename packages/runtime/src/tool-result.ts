/**
 * Build a model-visible tool result. Pi's agent loop determines tool failure
 * from a thrown error, not from an `isError` property on the returned value.
 */
export function toolResult(text: string, details: unknown, isError = false) {
	if (isError) {
		const metadata = details && typeof details === "object" && !Array.isArray(details)
			? details as Record<string, unknown>
			: {};
		const recovery = [
			typeof metadata.code === "string" ? `Code: ${metadata.code}.` : undefined,
			typeof metadata.nextAction === "string" ? `Next action: ${metadata.nextAction}` : undefined,
		].filter(Boolean).join(" ");
		throw new ToolExecutionError(`${text}${recovery ? `\n\n${recovery}` : ""}`);
	}
	return { content: [{ type: "text" as const, text }], details };
}

export class ToolExecutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolExecutionError";
	}
}
