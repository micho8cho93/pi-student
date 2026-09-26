import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { FileCredentialStore, getAuthPath } from "./auth-storage.js";
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
