import type { BudgetLane, CapabilityPolicy, WorkspaceBudgetRow, WorkspaceBudgetState } from "@pi-student/contracts";
import type { CapabilityState } from "@pi-student/policy/capability-runtime";

export type BudgetUsage = Pick<CapabilityState, "costLimitReached" | "agentLimitReached" | "tutoringLimitReached"
	| "startedAt" | "turns" | "tutoringTurns" | "tokens" | "cost">;

export interface BudgetSignals {
	/** Live session counters; limits come from the policy. */
	usage?: BudgetUsage;
	/** Host admission closed all AI (organization monthly budget, or controls unavailable). */
	exhausted?: string;
	/** Host admission closed agent execution but kept a tutoring reserve. */
	agentExhausted?: string;
	/** Host admission crossed a warning threshold. */
	warning?: string;
	now?: number;
}

const available: BudgetLane = { status: "available" };
const exhausted = (reason: string): BudgetLane => ({ status: "exhausted", reason });

/**
 * Projects the existing accounting onto workspace budget lanes. Nothing is
 * counted here: session counters live in CapabilityState and monthly usage in
 * the organization ledger (surfaced through model admission).
 */
export function resolveWorkspaceBudget(limits: CapabilityPolicy["limits"], signals: BudgetSignals = {}): WorkspaceBudgetState {
	const { usage, now = Date.now() } = signals;
	const overallReason = usage?.costLimitReached() ?? signals.exhausted;
	const overall = overallReason ? exhausted(overallReason) : signals.warning ? { status: "low" as const, reason: signals.warning } : available;
	const lane = (reason: string | undefined) => overall.status === "exhausted" || !reason ? overall : exhausted(reason);
	const left = (limit: number | null, used: number) => limit === null ? null : Math.max(0, limit - used);
	return {
		overall,
		agent: lane(usage?.agentLimitReached() ?? signals.agentExhausted),
		tutoring: lane(usage?.tutoringLimitReached()),
		// Autocomplete and architecture maps are tool-free, so they draw on the same reserve as tutoring
		// but are not counted against the session's tutoring allowance.
		autocomplete: overall,
		architecture: overall,
		session: {
			limits: { ...limits },
			remaining: {
				minutes: left(limits.minutes, usage ? (now - usage.startedAt) / 60_000 : 0),
				turns: left(limits.turns, usage?.turns ?? 0),
				tokens: left(limits.tokens, usage?.tokens ?? 0),
				cost: left(limits.cost, usage?.cost ?? 0),
				tutoringTurns: left(limits.tutoringTurns, usage?.tutoringTurns ?? 0),
			},
		},
	};
}

const STATUS_TEXT: Record<BudgetLane["status"], string> = {
	available: "available",
	low: "running low",
	exhausted: "used up for now",
	unavailable: "unavailable",
};

/**
 * Student-facing budget summary. Shows availability, never quotas: students
 * see what they can do, teachers configure the numbers.
 */
export function describeWorkspaceBudget(budget: WorkspaceBudgetState): WorkspaceBudgetRow[] {
	const rows = ([["agent", "AI implementation"], ["tutoring", "AI tutoring and help"], ["autocomplete", "Autocomplete"], ["architecture", "Architecture map"]] as const)
		.map(([lane, label]) => ({ lane, label, status: budget[lane].status, text: `${label}: ${STATUS_TEXT[budget[lane].status]}` }));
	return [...rows, { lane: "manual", label: "Editor, terminal, and tests", status: "unrestricted", text: "Editor, terminal, and tests: always available" }];
}
