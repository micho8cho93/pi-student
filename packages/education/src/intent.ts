import type { ProjectContext } from "./project-context.js";

export const PRIMARY_INTENTS = ["BUILD", "TUTOR", "EXPLAIN", "DEBUG", "CHECK"] as const;
export type LearningIntent = (typeof PRIMARY_INTENTS)[number];

export interface IntentRoute {
	intent?: LearningIntent;
	confidence: "high" | "medium" | "ambiguous";
	ambiguous: boolean;
	reason: string;
	scores: Record<LearningIntent, number>;
}

export interface IntentRoutingContext {
	projectContext?: ProjectContext;
	currentIntent?: LearningIntent;
}

/**
 * Small, deterministic first-pass router. The model still owns the nuanced
 * conversation, while this layer gives it a clear intent and question set.
 */
export function routeIntent(message: string, context: IntentRoutingContext = {}): IntentRoute {
	const text = message.trim().toLowerCase();
	const scores: Record<LearningIntent, number> = { BUILD: 0, TUTOR: 0, EXPLAIN: 0, DEBUG: 0, CHECK: 0 };

	add(scores, "DEBUG", text, [
		[/\b(debug|bug|broken|error|exception|stack trace|crash|fails?|failure|not working)\b/, 5],
		[/\b(keeps|still|unexpectedly|returns?\s+(?:500|404|null|undefined))\b/, 4],
		[/\b(why does|why is)\b.*\b(not|wrong|fail|through|crash)/, 4],
	]);
	add(scores, "EXPLAIN", text, [
		[/\b(explain|teach|what is|what are|how does|why does)\b/, 5],
		[/\b(concept|meaning|difference between|understand)\b/, 3],
	]);
	add(scores, "CHECK", text, [
		[/\b(review|check|look over|inspect|feedback|critique)\b/, 5],
		[/\b(is this|does this look|what do you think of)\b/, 2],
	]);
	add(scores, "TUTOR", text, [
		[/\b(help me (?:figure out|solve|work through|understand|write))\b/, 5],
		[/\b(give me a hint|guide me|walk me through|stuck)\b/, 5],
		[/\bwithout (?:giving|showing) me the answer\b/, 4],
	]);
	add(scores, "BUILD", text, [
		[/\b(build|create|make|add|implement|develop|scaffold|set up)\b/, 4],
		[/\b(website|app|game|feature|authentication|multiplayer|portfolio)\b/, 2],
	]);

	// A short continuation such as "go ahead" should keep the established
	// collaboration mode instead of becoming ambiguous and restarting routing.
	if (context.currentIntent && Math.max(...Object.values(scores)) === 0) scores[context.currentIntent] = 2;
	const ordered = [...PRIMARY_INTENTS].sort((left, right) => scores[right] - scores[left]);
	const best = ordered[0];
	const second = ordered[1];
	const bestScore = scores[best];
	const ambiguous = bestScore === 0 || bestScore === scores[second] || bestScore - scores[second] < 2;
	if (ambiguous) {
		return {
			confidence: "ambiguous",
			ambiguous: true,
			reason: bestScore === 0 ? "The request does not contain a clear intent signal yet." : "More than one learning approach fits the request equally well.",
			scores,
		};
	}
	return {
		intent: best,
		confidence: bestScore >= 5 ? "high" : "medium",
		ambiguous: false,
		reason: `Matched ${best} language in the student's request.`,
		scores,
	};
}

function add(scores: Record<LearningIntent, number>, intent: LearningIntent, text: string, patterns: readonly [RegExp, number][]): void {
	for (const [pattern, points] of patterns) if (pattern.test(text)) scores[intent] += points;
}
