import type { WorkspaceModelHealth, WorkspaceSurface } from "@pi-student/contracts";
import type { WorkspaceEventScope, WorkspaceEventStream } from "./workspace-events.js";

export type ModelExecutionFailure = Exclude<WorkspaceModelHealth["status"], "available"> | "context_window" | "cancelled" | "tool_failure" | "internal_error";
export type ModelHealthReporter = (health: WorkspaceModelHealth) => void | Promise<void>;

/** Conservative classification at a trusted model boundary. Raw errors never leave this function. */
export function classifyModelFailure(error: unknown): ModelExecutionFailure {
	const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
	const message = String(value.errorMessage ?? value.message ?? "").slice(0, 4_000).toLowerCase();
	const code = String(value.code ?? "").toUpperCase();
	const status = Number(value.status ?? value.statusCode ?? message.match(/^(?:http\s*)?(\d{3})\b/)?.[1]);
	if (value.stopReason === "aborted" || value.name === "AbortError" || /\b(cancelled|canceled|aborted)\b/.test(message)) return "cancelled";
	if (/context.{0,20}(window|length|limit)|too many tokens|maximum.{0,10}tokens/.test(message)) return "context_window";
	if (/\btool\b/.test(message)) return "tool_failure";
	if (/\bextension\b|internal error|referenceerror|syntaxerror/.test(message)) return "internal_error";
	if ([401, 403].includes(status) || /invalid api key|authentication failed|unauthorized/.test(message)) return "authentication_failure";
	if (/model.{0,60}(not found|does not exist|unavailable|not available)|model_not_found/.test(message)) return "model_unavailable";
	if (status === 503 || /provider unavailable|service unavailable/.test(message)) return "provider_unavailable";
	if ([408, 429, 500, 502, 504, 529].includes(status) || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)
		|| /fetch failed|network error|connection error|request timed out|overloaded_error/.test(message)) return "transient_failure";
	return "internal_error";
}

export function failedModelHealth(error: unknown): WorkspaceModelHealth | undefined {
	const status = classifyModelFailure(error);
	switch (status) {
		case "context_window": case "cancelled": case "tool_failure": case "internal_error": return undefined;
		default: return { status };
	}
}

/** The sole trusted publication path. Browser event ingestion does not allow model.health. */
export function workspaceModelHealthReporter(stream: WorkspaceEventStream, scope: WorkspaceEventScope | undefined, source: WorkspaceSurface): ModelHealthReporter {
	return async health => {
		if (!scope?.sessionId) return;
		try {
			await stream.refresh(scope);
			stream.emit(scope, source, { type: "model.health", available: health.status === "available", health });
		}
		catch { /* Best-effort metadata must not break execution. */ }
	};
}

/** Wrap only the provider call, never validation, admission, tools or parsing. */
export async function observeModelRequest<T extends { stopReason?: string; errorMessage?: string }>(request: () => Promise<T>, report?: ModelHealthReporter): Promise<T> {
	let result: T;
	try { result = await request(); }
	catch (error) { const health = failedModelHealth(error); if (health) await report?.(health); throw error; }
	if (result.stopReason === "error") { const health = failedModelHealth(result); if (health) await report?.(health); }
	else if (["stop", "length", "toolUse"].includes(result.stopReason ?? "")) await report?.({ status: "available" });
	return result;
}
