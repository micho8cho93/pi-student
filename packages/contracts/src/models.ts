export interface ModelDescriptor {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
}

/** Public catalog entry. Credentials and provider connection details are never included. */
export interface ModelProfile {
	id: string;
	organizationId: string;
	displayName: string;
	provider: string;
	providerModel: string;
	allowedThinkingLevels: import("./policy.js").ThinkingLevel[];
	available: boolean;
	fallbackProfileId?: string;
	version: number;
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

/** Optional host-side request admission. Implementations must fail closed for managed models. */
export interface ModelAdmissionProvider {
	/** purpose defaults to "agent", the most restrictive lane. */
	check(projectId: string, provider: string, modelId: string, thinkingLevel: import("./policy.js").ThinkingLevel, sessionId?: string,
		purpose?: import("./budget.js").BudgetPurpose): Promise<import("./budget.js").ModelAdmissionDecision>;
}
