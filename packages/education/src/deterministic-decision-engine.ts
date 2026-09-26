import { ResilientDecisionEngine, type DecisionContext, type DecisionEngine, type DecisionProvider, type ChoiceDecision, type ProbabilityDecision, type ScoreDecision } from "@pi-student/decision";
import { PRIMARY_INTENTS, routeIntent, type IntentRoute, type IntentRoutingContext, type LearningIntent } from "./intent.js";

/** Rich educational routing contract layered over the generic decision primitives. */
export interface EducationalDecisionEngine extends DecisionEngine {
	routeIntent(message: string, context?: IntentRoutingContext): IntentRoute;
}

/**
 * Production educational decisions. Intent choice reuses the established
 * router. Cases without a trustworthy deterministic rule abstain to the
 * current question flow instead of inventing a sufficiency verdict.
 */
export class DeterministicDecisionEngine implements EducationalDecisionEngine {
	private readonly validated: DecisionEngine;
	constructor() {
		const provider: DecisionProvider = {
			choose: async <T extends string>(input: DecisionContext, _question: string, choices: Record<T, string>) => {
				if (input.purpose !== "student-intent") throw new Error("No deterministic choice rule for this purpose");
				const route = routeIntent(input.text);
				if (!route.intent || !Object.hasOwn(choices, route.intent)) throw new Error("Intent is ambiguous");
				const probabilities = Object.fromEntries(Object.keys(choices).map(key => [key, key === route.intent ? 1 : 0])) as Record<T, number>;
				return { value: route.intent as T, probabilities };
			},
			yesNo: async () => { throw new Error("No deterministic sufficiency rule from this bounded request alone"); },
			score: async () => { throw new Error("No deterministic scoring rule for this purpose"); },
		};
		this.validated = new ResilientDecisionEngine(provider, { high: 0.9, medium: 0.7 });
	}

	/** Rich route used by the existing workflow; preserves scores and continuation behavior exactly. */
	routeIntent(message: string, context: IntentRoutingContext = {}): IntentRoute {
		return routeIntent(message, context);
	}

	choose<T extends string>(input: DecisionContext, question: string, choices: Record<T, string>): Promise<ChoiceDecision<T>> {
		return this.validated.choose(input, question, choices);
	}
	yesNo(input: DecisionContext, question: string): Promise<ProbabilityDecision> {
		return this.validated.yesNo(input, question);
	}
	score(input: DecisionContext, question: string, criteria: readonly string[]): Promise<ScoreDecision> {
		return this.validated.score(input, question, criteria);
	}
}

export const EDUCATIONAL_INTENT_CHOICES: Record<LearningIntent, string> = Object.fromEntries(
	PRIMARY_INTENTS.map(intent => [intent, intent.toLowerCase()]),
) as Record<LearningIntent, string>;
