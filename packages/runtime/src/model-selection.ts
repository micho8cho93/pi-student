import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExecutionContext } from "@pi-student/contracts";
import { modelAllowed } from "@pi-student/policy/capability-policy";

type NativeModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;
export type ModelSelection = { model: NativeModel; requested?: string; fallbackFrom?: string };

/** The only model inventory used by the Terminal and Paseo execution surfaces. */
export async function availableExecutionModels(runtime: ModelRuntime, context: ExecutionContext): Promise<NativeModel[]> {
	if (context.classId && !context.projectId) return [];
	if (context.organizationId && !context.policy?.settings.models.length) return [];
	const available = await runtime.getAvailable();
	return available.filter(model => runtime.getProviderAuthStatus(model.provider).configured)
		.filter(model => !context.policy || modelAllowed(context.policy.settings, model));
}

export async function selectExecutionModel(runtime: ModelRuntime, context: ExecutionContext,
	requested?: string, session?: Pick<SessionManager, "buildSessionContext">): Promise<ModelSelection> {
	const saved = session?.buildSessionContext().model;
	const selected = requested ?? (saved ? `${saved.provider}/${saved.modelId}` : undefined);
	const models = await availableExecutionModels(runtime, context);
	if (selected) {
		const model = models.find(item => `${item.provider}/${item.id}` === selected);
		if (!model) throw new Error(`Selected model ${selected} is unavailable or no longer approved. Choose an available model.`);
		return { model, requested: selected };
	}
	const model = models[0];
	if (!model) throw new Error(context.organizationId ? "No institution-approved model is available for this project." : "No configured model is available.");
	return { model };
}

export async function assertExecutionModel(runtime: ModelRuntime, context: ExecutionContext, model: { provider: string; id: string }): Promise<void> {
	if (!(await availableExecutionModels(runtime, context)).some(item => item.provider === model.provider && item.id === model.id)) {
		throw new Error(`Model ${model.provider}/${model.id} is unavailable or no longer approved.`);
	}
}

/** A provider failure may switch only to another currently approved model. */
export async function selectFallbackModel(runtime: ModelRuntime, context: ExecutionContext,
	failed: { provider: string; id: string }, preferred?: string): Promise<ModelSelection | undefined> {
	const candidates = (await availableExecutionModels(runtime, context))
		.filter(item => item.provider !== failed.provider || item.id !== failed.id);
	const model = preferred ? candidates.find(item => `${item.provider}/${item.id}` === preferred)
		: candidates.sort((left, right) => Number(right.reasoning) - Number(left.reasoning))[0];
	return model ? { model, fallbackFrom: `${failed.provider}/${failed.id}` } : undefined;
}

const inventoryGuards = new WeakMap<ModelRuntime, { allowed: Set<string> }>();

/** Pi RPC's synchronous model inventory must show the same models the guard permits. */
export async function refreshSessionModelInventory(runtime: ModelRuntime, context: ExecutionContext): Promise<void> {
	let guard = inventoryGuards.get(runtime);
	if (!guard) {
		guard = { allowed: new Set() };
		const original = runtime.getAvailableSnapshot.bind(runtime);
		const current = guard;
		runtime.getAvailableSnapshot = () => original().filter(model => current.allowed.has(`${model.provider}/${model.id}`));
		inventoryGuards.set(runtime, guard);
	}
	guard.allowed = new Set((await availableExecutionModels(runtime, context)).map(model => `${model.provider}/${model.id}`));
}
