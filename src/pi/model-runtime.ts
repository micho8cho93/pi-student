import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FileCredentialStore, getAuthPath } from "./auth-storage.js";
import { resolveThinkingLevel, type ThinkingModelCapabilities, type ThinkingLevel } from "./thinking.js";

export async function createModelRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create({
		// Keep the SDK's normal global location, but supply a durable store so
		// onboarding writes are visible to the runtime and future invocations.
		authPath: getAuthPath(),
		credentials: new FileCredentialStore(),
	});
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
