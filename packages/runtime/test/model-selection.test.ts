import { describe, expect, it } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExecutionContext } from "@pi-student/contracts";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import { availableExecutionModels, refreshSessionModelInventory, selectExecutionModel, selectFallbackModel } from "../src/model-selection.js";

const small = { provider: "openai", id: "small", name: "Small", reasoning: false, cost: { input: 1, output: 1 } };
const other = { provider: "other", id: "other", name: "Other", reasoning: false, cost: { input: 2, output: 2 } };
const context = (models: string[]): ExecutionContext => ({ workspacePath: "/workspace", identity: { kind: "student", userId: "student" },
	projectId: "project", organizationId: "org", sandbox: { mode: "gondolin" },
	policy: { projectId: "project", version: 1, sourceVersions: { organization: 1 }, settings: { ...DEFAULT_CAPABILITY_POLICY, models } } });
const fake = (models = [small, other], disconnected: string[] = []) => ({
	getAvailable: async () => models,
	getAvailableSnapshot: () => models,
	getProviderAuthStatus: (provider: string) => ({ configured: !disconnected.includes(provider) }),
} as unknown as ModelRuntime);

describe("shared model selection", () => {
	it("shows and executes only approved, connected models", async () => {
		const runtime = fake();
		expect((await availableExecutionModels(runtime, context(["openai/small"]))).map(model => model.id)).toEqual(["small"]);
		await refreshSessionModelInventory(runtime, context(["openai/small"]));
		expect(runtime.getAvailableSnapshot().map(model => model.id)).toEqual(["small"]);
		expect((await selectExecutionModel(runtime, context(["openai/small"]))).model.id).toBe("small");
	});
	it("fails closed for stale, removed, and disconnected selections across restart", async () => {
		const saved = { buildSessionContext: () => ({ model: { provider: "openai", modelId: "removed" } }) };
		await expect(selectExecutionModel(fake(), context(["openai/small"]), undefined, saved as never)).rejects.toThrow("unavailable");
		await expect(selectExecutionModel(fake(), context(["other/other"]), "openai/small")).rejects.toThrow("no longer approved");
		await expect(selectExecutionModel(fake([small], ["openai"]), context(["openai/small"]))).rejects.toThrow("No institution-approved");
		const restarted = fake();
		await expect(selectExecutionModel(restarted, context(["openai/small"]), undefined, saved as never)).rejects.toThrow("unavailable");
	});
	it("returns the actual fallback identity and never selects a disallowed model", async () => {
		const fallback = await selectFallbackModel(fake(), context(["openai/small", "other/other"]), small);
		expect(fallback).toMatchObject({ fallbackFrom: "openai/small", model: { provider: "other", id: "other" } });
		expect((await selectFallbackModel(fake(), context(["openai/small", "other/other"]), small, "other/other"))?.model.id).toBe("other");
		expect(await selectFallbackModel(fake(), context(["openai/small", "other/other"]), small, "institution/removed")).toBeUndefined();
		expect(await selectFallbackModel(fake(), context(["openai/small"]), small)).toBeUndefined();
		expect(await availableExecutionModels(fake(), context([]))).toEqual([]);
	});
});
