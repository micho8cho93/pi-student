import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CAPABILITY_POLICY, allowedReasoningLevels, modelAllowed, type EffectivePolicy } from "./capability-policy.js";

export class CapabilityState {
	effective?: EffectivePolicy;
	blocked: Record<string, number> = {};
	startedAt = Date.now();
	turns = 0;
	tokens = 0;
	cost = 0;
	unavailable = false;
	get settings() { return this.effective?.settings ?? DEFAULT_CAPABILITY_POLICY; }
	select(effective?: EffectivePolicy) {
		this.effective = effective ? structuredClone(effective) : undefined;
		this.blocked = {}; this.startedAt = Date.now(); this.turns = 0; this.tokens = 0; this.cost = 0; this.unavailable = false;
	}
	block(capability: string) { this.blocked[capability] = (this.blocked[capability] ?? 0) + 1; }
	limitReached(): string | undefined {
		if (this.unavailable) return "Project controls could not be loaded. Reconnect using /projects.";
		const limits = this.settings.limits;
		if (limits.minutes !== null && Date.now() - this.startedAt >= limits.minutes * 60_000) return "The project session time limit has been reached.";
		if (limits.turns !== null && this.turns >= limits.turns) return "The project session response limit has been reached.";
		if (limits.tokens !== null && this.tokens >= limits.tokens) return "The project session token limit has been reached.";
		if (limits.cost !== null && this.cost >= limits.cost) return "The project session cost limit has been reached.";
	}
}
const states = new WeakMap<object, CapabilityState>();
export function capabilityState(workflow: object): CapabilityState {
	let state = states.get(workflow);
	if (!state) { state = new CapabilityState(); states.set(workflow, state); }
	return state;
}

/** Enforce at the shared session boundary, including SDK pickers and RPC setters. */
export function guardCapabilitySession(session: AgentSession, state: CapabilityState,
	validateModel?: (model: { provider: string; id: string } | undefined) => Promise<void>): void {
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
		if (reason) { state.block("sessionLimits"); throw new Error(reason); }
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
