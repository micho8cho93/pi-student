/** Only educational decisions may cross this boundary. Add purposes deliberately. */
export type DecisionPurpose = "student-intent" | "context-sufficiency" | "missing-context";

export interface DecisionContext {
	purpose: DecisionPurpose;
	/** A bounded, redacted description of the immediate student request. */
	text: string;
	/** Short facts supplied by the caller; never file contents or arbitrary objects. */
	facts?: readonly string[];
}

export interface ChoiceEvidence<T extends string> {
	value: T;
	probabilities: Record<T, number>;
}
export interface ProbabilityEvidence { probability: number }
export interface ScoreEvidence { score: number; probabilities: number[] }

export interface DecisionProvider {
	choose<T extends string>(input: DecisionContext, question: string, choices: Record<T, string>): Promise<ChoiceEvidence<T>>;
	yesNo(input: DecisionContext, question: string): Promise<ProbabilityEvidence>;
	score(input: DecisionContext, question: string, criteria: readonly string[]): Promise<ScoreEvidence>;
	close?(): Promise<void>;
}

export type ConfidenceBand = "high" | "medium" | "low";
export type FallbackReason = "unavailable" | "invalid" | "medium-confidence" | "low-confidence";

export interface DecisionResult<T> {
	value?: T;
	confidence?: number;
	band?: ConfidenceBand;
	latencyMs: number;
	fallbackUsed: boolean;
	fallbackReason?: FallbackReason;
}
/** Metadata-only observation; never attach a request, prompt, source text, or secret. */
export interface DecisionObservation<T extends string | boolean | number = string | boolean | number> {
	purpose: DecisionPurpose;
	rawDecision?: T;
	decision?: T;
	confidence?: number;
	latencyMs: number;
	fallbackUsed: boolean;
	fallbackReason?: FallbackReason;
}
export type ChoiceDecision<T extends string> = DecisionResult<T> & { probabilities?: Record<T, number> };
export type ProbabilityDecision = DecisionResult<boolean> & { probability?: number };
export type ScoreDecision = DecisionResult<number> & { probabilities?: number[] };

export interface ConfidencePolicy {
	/** Measured on local fixtures before promotion. 0..1, high > medium. */
	high: number;
	medium: number;
}

export interface DecisionEngine {
	choose<T extends string>(input: DecisionContext, question: string, choices: Record<T, string>): Promise<ChoiceDecision<T>>;
	yesNo(input: DecisionContext, question: string): Promise<ProbabilityDecision>;
	score(input: DecisionContext, question: string, criteria: readonly string[]): Promise<ScoreDecision>;
	close?(): Promise<void>;
}

const validProbability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function confidenceBand(confidence: number, policy: ConfidencePolicy): ConfidenceBand {
	if (confidence >= policy.high) return "high";
	if (confidence >= policy.medium) return "medium";
	return "low";
}

/** An abstaining fallback lets the existing deterministic or generative path decide. */
export class ResilientDecisionEngine implements DecisionEngine {
	constructor(private readonly provider: DecisionProvider, private readonly policy: ConfidencePolicy) {
		if (!validProbability(policy.medium) || !validProbability(policy.high) || policy.high <= policy.medium) throw new Error("Invalid confidence policy");
	}
	async close(): Promise<void> { await this.provider.close?.(); }

	async choose<T extends string>(input: DecisionContext, question: string, choices: Record<T, string>): Promise<ChoiceDecision<T>> {
		const start = performance.now();
		try {
			validateInput(input, question);
			const keys = Object.keys(choices) as T[];
			if (keys.length < 2 || keys.length > 12 || keys.some(key => !key.trim() || !choices[key]?.trim() || choices[key].length > 160)) throw new Error("Invalid choices");
			const answer = await this.provider.choose(input, question, choices);
			const probabilities = answer?.probabilities;
			if (!keys.includes(answer?.value) || !probabilities || keys.some(key => !validProbability(probabilities[key])) ||
				Math.abs(keys.reduce((sum, key) => sum + probabilities[key], 0) - 1) > 0.02) throw new Error("Malformed choice inference");
			const confidence = probabilities[answer.value];
			if (confidence < Math.max(...keys.map(key => probabilities[key])) - 1e-6) throw new Error("Choice does not match probabilities");
			const band = confidenceBand(confidence, this.policy);
			return { value: band === "high" ? answer.value : undefined, probabilities, confidence, band, latencyMs: performance.now() - start,
				fallbackUsed: band !== "high", ...(band === "high" ? {} : { fallbackReason: `${band}-confidence` as FallbackReason }) };
		} catch (error) { return abstain(start, error); }
	}

	async yesNo(input: DecisionContext, question: string): Promise<ProbabilityDecision> {
		const start = performance.now();
		try {
			validateInput(input, question);
			const { probability } = await this.provider.yesNo(input, question);
			if (!validProbability(probability)) throw new Error("Malformed probability inference");
			const confidence = Math.max(probability, 1 - probability);
			const band = confidenceBand(confidence, this.policy);
			return { value: band === "high" ? probability >= 0.5 : undefined, probability, confidence, band, latencyMs: performance.now() - start,
				fallbackUsed: band !== "high", ...(band === "high" ? {} : { fallbackReason: `${band}-confidence` as FallbackReason }) };
		} catch (error) { return abstain(start, error); }
	}

	async score(input: DecisionContext, question: string, criteria: readonly string[]): Promise<ScoreDecision> {
		const start = performance.now();
		try {
			validateInput(input, question);
			if (criteria.length < 2 || criteria.length > 12 || criteria.some(item => !item.trim() || item.length > 160)) throw new Error("Invalid criteria");
			const { score, probabilities } = await this.provider.score(input, question, criteria);
			if (!Number.isFinite(score) || score < 0 || score > criteria.length - 1 || probabilities.length !== criteria.length ||
				probabilities.some(value => !validProbability(value)) || Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) > 0.02) throw new Error("Malformed score inference");
			const confidence = Math.max(...probabilities);
			const band = confidenceBand(confidence, this.policy);
			return { value: band === "high" ? score : undefined, probabilities, confidence, band, latencyMs: performance.now() - start,
				fallbackUsed: band !== "high", ...(band === "high" ? {} : { fallbackReason: `${band}-confidence` as FallbackReason }) };
		} catch (error) { return abstain(start, error); }
	}
}

function abstain(start: number, error: unknown): DecisionResult<never> {
	return { latencyMs: performance.now() - start, fallbackUsed: true,
		fallbackReason: error instanceof Error && /Malformed|Invalid/.test(error.message) ? "invalid" : "unavailable" };
}

function validateInput(input: DecisionContext, question: string): void {
	if (!["student-intent", "context-sufficiency", "missing-context"].includes(input.purpose) || !input.text.trim() || input.text.length > 1600 ||
		!question.trim() || question.length > 240 || (input.facts?.length ?? 0) > 8 || input.facts?.some(fact => fact.length > 120)) throw new Error("Invalid decision input");
}

/** Source and secrets are removed before a request reaches any provider. */
export function boundedStudentContext(purpose: DecisionPurpose, message: string, facts: readonly string[] = []): DecisionContext {
	const clean = (value: string) => value
		.replace(/```[\s\S]*?```/g, "[code omitted]")
		.replace(/```[\s\S]*$/g, "[code omitted]")
		.replace(/`[^`\n]+`/g, "[code omitted]")
		.replace(/^\s*(?:import |export |const |let |var |function |class |def |from |#include|<\/?[A-Za-z]|[{}\[\]])[^\n]*$/gm, "[code omitted]")
		.replace(/(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,}|AIza[A-Za-z0-9_-]{20,}|bearer\s+\S+|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|password|secret)\s*[:=]\s*\S+)/gi, "[secret omitted]")
		.replace(/\b[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email omitted]")
		.replace(/(?:\/Users\/|\/home\/)[^\s]+/g, "[path omitted]")
		.replace(/\s+/g, " ").trim();
	return { purpose, text: clean(message).slice(0, 1600) || "[empty request]", facts: facts.slice(0, 8).map(fact => clean(fact).slice(0, 120)) };
}
