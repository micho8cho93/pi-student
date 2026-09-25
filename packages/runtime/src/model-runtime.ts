import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FileCredentialStore, getAuthPath } from "./auth-storage.js";
import { resolveThinkingLevel, type ThinkingModelCapabilities, type ThinkingLevel } from "@pi-student/policy/thinking";
import { OllamaDiscoveryError, readOllamaUrl, registerOllama } from "./ollama.js";

export async function createModelRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		// Keep the SDK's normal global location, but supply a durable store so
		// onboarding writes are visible to the runtime and future invocations.
		authPath: getAuthPath(),
		credentials: new FileCredentialStore(),
	});
	const ollamaUrl = await readOllamaUrl();
	if (ollamaUrl) {
		// Offline, timed-out, and empty local servers are normal lifecycle states;
		// malformed or incompatible endpoints are configuration/programming errors
		// and must remain observable instead of being silently treated as offline.
		try { await registerOllama(runtime, ollamaUrl); }
		catch (error) {
			if (!(error instanceof OllamaDiscoveryError && ["OLLAMA_OFFLINE", "OLLAMA_TIMEOUT", "OLLAMA_NO_MODELS"].includes(error.code))) throw error;
		}
	}
	return runtime;
}

export function findFallbackModel(runtime: ModelRuntime, current: { provider: string; id: string }, allowed: (model: ReturnType<ModelRuntime["getAvailableSnapshot"]>[number]) => boolean = () => true): ReturnType<ModelRuntime["getAvailableSnapshot"]>[number] | undefined {
	return runtime
		.getAvailableSnapshot()
		.filter((model) => `${model.provider}/${model.id}` !== `${current.provider}/${current.id}`)
		.filter((model) => runtime.getProviderAuthStatus(model.provider).configured)
		.filter(allowed)
		.sort((left, right) => Number(right.reasoning) - Number(left.reasoning))[0];
}

export function normalizeFallbackThinkingLevel(model: ThinkingModelCapabilities, requested: ThinkingLevel): ThinkingLevel {
	// Kept as a named runtime boundary so model fallback and direct model
	// selection cannot accidentally reuse an unsupported provider level.
	return resolveThinkingLevel(model, requested);
}
