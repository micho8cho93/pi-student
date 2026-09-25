import type { ModelDescriptor, ModelProfile, ModelProvider, ModelQuery, ModelResolution } from "@pi-student/contracts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModelRuntime } from "./model-runtime.js";

/** Model provider shape needed by the Pi-backed runtime composition layer. */
export interface StudentModelProvider extends ModelProvider {
	readonly runtime: ModelRuntime;
}

/** Wraps Pi's current direct-provider model catalog behind the stable provider contract. */
export class DirectModelProvider implements StudentModelProvider {
	private constructor(readonly runtime: ModelRuntime) {}
	private hosted?: { projectId: string; url: string; profiles: ModelProfile[] };
	static async create(runtime?: ModelRuntime): Promise<DirectModelProvider> { return new DirectModelProvider(runtime ?? await createModelRuntime()); }
	configureHostedProfiles(projectId: string, url: string, profiles: ModelProfile[], studentToken: string): void {
		const endpoint = new URL(url);
		if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1"].includes(endpoint.hostname))) throw new Error("Model gateway requires HTTPS.");
		if (!studentToken) throw new Error("Student sign-in required for institution models.");
		this.hosted = { projectId, url: endpoint.toString().replace(/\/$/, ""), profiles };
		this.refreshHostedToken(studentToken);
	}
	refreshHostedToken(studentToken: string, sessionId?: string, thinkingLevel?: string): void {
		if (!this.hosted || !studentToken) throw new Error("Institution models are not configured.");
		const { projectId, url, profiles } = this.hosted;
		this.runtime.registerProvider("institution", {
			name: "Institution models", api: "openai-completions", baseUrl: `${url}/projects/${encodeURIComponent(projectId)}/v1`,
			apiKey: studentToken, authHeader: true,
			headers: { ...(sessionId ? { "X-Pi-Session-Id": sessionId } : {}), ...(thinkingLevel ? { "X-Pi-Thinking-Level": thinkingLevel } : {}) },
			models: profiles.filter(profile => profile.available).map(profile => ({
				id: profile.id, name: profile.displayName, api: "openai-completions", reasoning: profile.allowedThinkingLevels.some(level => level !== "off"),
				thinkingLevelMap: Object.fromEntries((["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)
					.map(level => [level, profile.allowedThinkingLevels.includes(level) ? (level === "off" ? undefined : level) : null])),
				input: ["text"] as ("text")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000, maxTokens: 4_096,
			})),
		});
	}
	async listModels(query: ModelQuery = {}): Promise<ModelDescriptor[]> {
		return this.runtime.getAvailableSnapshot()
			.filter(model => !query.provider || model.provider === query.provider)
			.filter(model => query.includeUnavailable || this.runtime.getProviderAuthStatus(model.provider).configured)
			.map(model => ({ provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow }));
	}
	async resolveModel(provider: string, modelId: string): Promise<ModelResolution | undefined> {
		const model = this.runtime.getModel(provider, modelId);
		return model ? { descriptor: { provider: model.provider, id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow }, native: model } : undefined;
	}
}
