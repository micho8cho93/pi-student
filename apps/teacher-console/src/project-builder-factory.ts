import { createProjectBuilder, type ProjectBuilder } from "@pi-student/classroom/project-builder";
import { createModelRuntime } from "@pi-student/runtime/model-runtime";
import { findReadyProvider } from "@pi-student/runtime/setup";

export async function createDefaultProjectBuilder(): Promise<ProjectBuilder> {
	const runtime = await createModelRuntime();
	await runtime.refresh({ allowNetwork: false });
	const ready = await findReadyProvider(runtime);
	if (!ready) throw new Error("No configured Pi model is available. Run pi-student terminal once to configure a provider, then try again.");
	const model = runtime.getModel(ready.providerId, ready.modelId);
	if (!model) throw new Error("The configured Pi model is unavailable. Refresh provider setup and try again.");
	return createProjectBuilder(runtime, model);
}
