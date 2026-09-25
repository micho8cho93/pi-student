import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CAPABILITY_POLICY, allowedReasoningLevels, modelAllowed, type EffectivePolicy } from "./capability-policy.js";

export class CapabilityState {
	effective?: EffectivePolicy;
	blocked: Record<string, number> = {};
	startedAt = Date.now();
	/** Responses while agent execution was available. */
	turns = 0;
	/** Tool-free responses after the agent limits were reached. */
	tutoringTurns = 0;
	tokens = 0;
	cost = 0;
	unavailable = false;
	/** Set by host admission when an organization budget closes agent execution but keeps a tutoring reserve. */
	agentBlocked?: string;
	get settings() { return this.effective?.settings ?? DEFAULT_CAPABILITY_POLICY; }
	select(effective?: EffectivePolicy) {
		this.effective = effective ? structuredClone(effective) : undefined;
		this.blocked = {}; this.startedAt = Date.now(); this.turns = 0; this.tutoringTurns = 0; this.tokens = 0; this.cost = 0;
		this.unavailable = false; this.agentBlocked = undefined;
	}
	block(capability: string) { this.blocked[capability] = (this.blocked[capability] ?? 0) + 1; }
	/** Educational limits on the AI doing the work. Tutoring may continue after these. */
	agentLimitReached(): string | undefined {
		const limits = this.settings.limits;
		if (limits.minutes !== null && Date.now() - this.startedAt >= limits.minutes * 60_000) return "The project's agent time limit for this session has been reached.";
		if (limits.turns !== null && this.turns >= limits.turns) return "The project's agent response limit for this session has been reached.";
		return this.agentBlocked;
	}
	/** Cost limits. They stop all AI in the session. */
	costLimitReached(): string | undefined {
		if (this.unavailable) return "Project controls could not be loaded. Reconnect using /projects.";
		const limits = this.settings.limits;
		if (limits.tokens !== null && this.tokens >= limits.tokens) return "The project session token limit has been reached.";
		if (limits.cost !== null && this.cost >= limits.cost) return "The project session cost limit has been reached.";
	}
	/** The tutoring reserve, which only applies once the agent limits are reached. */
	tutoringLimitReached(): string | undefined {
		const limit = this.settings.limits.tutoringTurns;
		if (limit !== null && this.tutoringTurns >= limit && this.agentLimitReached()) return "The project's tutoring allowance for this session has been used.";
	}
	/** Whether the session's conversation must stop: a cost limit, or the tutoring reserve after the agent limits. */
	limitReached(): string | undefined { return this.costLimitReached() ?? this.tutoringLimitReached(); }
	/** Agent execution is closed but tool-free help remains. */
	tutoringOnly(): boolean { return !this.limitReached() && this.agentLimitReached() !== undefined; }
}
const states = new WeakMap<object, CapabilityState>();
export function capabilityState(workflow: object): CapabilityState {
	let state = states.get(workflow);
	if (!state) { state = new CapabilityState(); states.set(workflow, state); }
	return state;
}

/**
 * Enforce at the shared session boundary, including SDK pickers and RPC setters.
 * explainLimit turns a reached limit into a message that says what the student can still do.
 */
export function guardCapabilitySession(session: AgentSession, state: CapabilityState,
	validateModel?: (model: { provider: string; id: string } | undefined) => Promise<void>,
	explainLimit?: (reason: string) => Promise<string | undefined>): void {
	const setModel = session.setModel.bind(session);
	const setThinking = session.setThinkingLevel.bind(session);
	const available = session.getAvailableThinkingLevels.bind(session);
	const prompt = session.prompt.bind(session);
	session.getAvailableThinkingLevels = () => available().filter(level => state.settings.reasoningLevels.includes(level));
	session.setThinkingLevel = (level, options) => {
		if (!session.model) return setThinking(level, options);
		const permitted = allowedReasoningLevels(state.settings, session.model);
		if (!permitted.includes(level)) { state.block("reasoningLevels"); throw new Error("That reasoning level is not enabled for this project and model."); }
		setThinking(level, options);
	};
	session.setModel = async (model, options) => {
		await validateModel?.(model);
		if (state.effective?.sourceVersions?.organization && !state.settings.models.length) { state.block("models"); throw new Error("No model is approved for this project."); }
		if (!modelAllowed(state.settings, model)) { state.block("models"); throw new Error("That model is not enabled for this project, or supports none of its reasoning levels."); }
		await setModel(model, options);
		const permitted = allowedReasoningLevels(state.settings, model);
		if (!permitted.includes(session.thinkingLevel)) setThinking(permitted[0]!);
	};
	session.prompt = async (text, options) => {
		await validateModel?.(session.model);
		const reason = state.limitReached();
		if (reason) { state.block("sessionLimits"); throw new Error(await explainLimit?.(reason).catch(() => undefined) ?? reason); }
		if (state.effective?.sourceVersions?.organization && !state.settings.models.length) { state.block("models"); throw new Error("No model is approved for this project."); }
		if (session.model && !modelAllowed(state.settings, session.model)) { state.block("models"); throw new Error("Select an approved model with an enabled reasoning level before continuing."); }
		if (session.model) {
			const permitted = allowedReasoningLevels(state.settings, session.model);
			if (!permitted.includes(session.thinkingLevel)) setThinking(permitted[0]!);
		}
		if (options?.images?.length && !state.settings.imageUploads) { state.block("imageUploads"); throw new Error("Image uploads are disabled for this project."); }
		return prompt(text, options);
	};
}
