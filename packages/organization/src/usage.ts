export type MeteredResource = "model_tokens" | "sandbox_compute" | "storage" | "other";
export interface UsageRecord {
	id: string;
	organizationId: string;
	classId: string;
	userId: string;
	projectId?: string;
	sessionId: string;
	provider: string;
	providerModel: string;
	modelProfileId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	estimatedCostMicros: number | null;
	pricingVersion: string | null;
	resource: MeteredResource;
	recordedAt: string;
}
export interface TokenPrice {
	version: string;
	inputMicrosPerMillion: number;
	outputMicrosPerMillion: number;
	cacheReadMicrosPerMillion: number;
	cacheWriteMicrosPerMillion: number;
}
export function calculateEstimatedCostMicros(usage: Pick<UsageRecord, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">, price?: TokenPrice): number | null {
	if (!price) return null;
	for (const value of [...Object.values(usage), ...[price.inputMicrosPerMillion, price.outputMicrosPerMillion, price.cacheReadMicrosPerMillion, price.cacheWriteMicrosPerMillion]]) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid usage or price.");
	}
	return Math.ceil((usage.inputTokens * price.inputMicrosPerMillion + usage.outputTokens * price.outputMicrosPerMillion +
		usage.cacheReadTokens * price.cacheReadMicrosPerMillion + usage.cacheWriteTokens * price.cacheWriteMicrosPerMillion) / 1_000_000);
}

export type BudgetAction = "warn" | "block_model" | "fallback" | "block_ai";
export interface BudgetRule {
	limitMicros: number | null;
	tokenLimit: number | null;
	warningFraction: number;
	hardAction: Exclude<BudgetAction, "warn">;
}
export function evaluateBudget(rule: BudgetRule, spentMicros: number, tokens: number, reservationMicros: number, reservationTokens: number): { warning: boolean; blocked: boolean; action?: BudgetAction } {
	const costRatio = rule.limitMicros == null ? 0 : (spentMicros + reservationMicros) / rule.limitMicros;
	const tokenRatio = rule.tokenLimit == null ? 0 : (tokens + reservationTokens) / rule.tokenLimit;
	const ratio = Math.max(costRatio, tokenRatio);
	return { warning: ratio >= rule.warningFraction, blocked: ratio > 1, ...(ratio > 1 ? { action: rule.hardAction } : ratio >= rule.warningFraction ? { action: "warn" as const } : {}) };
}
