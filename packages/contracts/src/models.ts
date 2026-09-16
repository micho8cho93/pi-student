export interface ModelDescriptor {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
}

export interface ModelResolution {
	descriptor: ModelDescriptor;
	/** Provider-specific value consumed only by the application composition root. */
	native?: unknown;
}

export interface ModelQuery {
	provider?: string;
	includeUnavailable?: boolean;
}

/** Catalog and resolution seam for direct, hosted, gateway, and local models. */
export interface ModelProvider {
	listModels(query?: ModelQuery): Promise<ModelDescriptor[]>;
	resolveModel(provider: string, modelId: string): Promise<ModelResolution | undefined>;
}
