import type { ModelDescriptor, ModelProvider, ModelQuery, ModelResolution } from "@pi-student/contracts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModelRuntime } from "./model-runtime.js";

/** Model provider shape needed by the Pi-backed runtime composition layer. */
export interface StudentModelProvider extends ModelProvider {
	readonly runtime: ModelRuntime;
}

/** Wraps Pi's current direct-provider model catalog behind the stable provider contract. */
export class DirectModelProvider implements StudentModelProvider {
	private constructor(readonly runtime: ModelRuntime) {}
	static async create(runtime?: ModelRuntime): Promise<DirectModelProvider> { return new DirectModelProvider(runtime ?? await createModelRuntime()); }
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
