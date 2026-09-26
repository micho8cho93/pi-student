import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyModelFailure, failedModelHealth, observeModelRequest, workspaceModelHealthReporter } from "../src/workspace-model-health.js";
import { WorkspaceEventJournal, WorkspaceEventStream } from "../src/workspace-events.js";

describe("trusted model health observations", () => {
	it.each([
		[{ status: 503, message: "secret response" }, "provider_unavailable"],
		[{ errorMessage: "503 upstream" }, "provider_unavailable"],
		[{ errorMessage: "model_not_found" }, "model_unavailable"],
		[{ status: 401 }, "authentication_failure"],
		[{ errorMessage: "Invalid API key: secret" }, "authentication_failure"],
		[{ code: "ECONNRESET" }, "transient_failure"],
		[{ status: 429 }, "transient_failure"],
		[{ errorMessage: "context length exceeded" }, "context_window"],
		[{ stopReason: "aborted", errorMessage: "503" }, "cancelled"],
		[{ name: "AbortError" }, "cancelled"],
		[{ errorMessage: "User cancelled request" }, "cancelled"],
		[{ errorMessage: "tool execution failed" }, "tool_failure"],
		[{ errorMessage: "extension handler failed" }, "internal_error"],
		[{ stopReason: "error" }, "internal_error"],
	] as const)("classifies %j as %s without persisting details", (error, expected) => {
		expect(classifyModelFailure(error)).toBe(expected);
		const health = failedModelHealth(error);
		if (["context_window", "cancelled", "tool_failure", "internal_error"].includes(expected)) expect(health).toBeUndefined();
		else expect(health).toEqual({ status: expected });
	});

	it("recovers across reporters, ignores cancellations/internal errors, and cannot cross sessions", async () => {
		const stream = new WorkspaceEventStream();
		const scope = { projectPath: "/project", sessionId: "one" };
		const map = workspaceModelHealthReporter(stream, scope, "flowchart");
		const chat = workspaceModelHealthReporter(stream, scope, "chat");
		await expect(observeModelRequest(async () => { throw Object.assign(new Error("secret"), { status: 503 }); }, map)).rejects.toThrow("secret");
		expect(stream.session(scope).model).toMatchObject({ available: false, health: { status: "provider_unavailable" } });
		for (const result of [{ stopReason: "aborted" }, { stopReason: "error", errorMessage: "internal error" }]) await observeModelRequest(async () => result, chat);
		expect(stream.session(scope).model?.available).toBe(false);
		expect(stream.session({ ...scope, sessionId: "two" })).toEqual({});
		expect(JSON.stringify(stream.events(scope))).not.toContain("secret");
		await observeModelRequest(async () => ({ stopReason: "stop" }), chat);
		expect(stream.session(scope).model).toMatchObject({ available: true, health: { status: "available" } });
		await workspaceModelHealthReporter(stream, { projectPath: scope.projectPath }, "editor")({ status: "provider_unavailable" });
		expect(stream.session(scope).model?.available).toBe(true);
	});
	it("refreshes another process's outage before publishing recovery and replays only bounded metadata", async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), "model-health-"));
		try {
			const journal = new WorkspaceEventJournal(directory);
			const scope = { projectPath: directory, sessionId: "one" };
			const chat = new WorkspaceEventStream({ journal }), map = new WorkspaceEventStream({ journal });
			await workspaceModelHealthReporter(chat, scope, "chat")({ status: "provider_unavailable" });
			await journal.flush();
			// Map has never read Chat's failure. Recovery must remain newer even after another refresh.
			await workspaceModelHealthReporter(map, scope, "flowchart")({ status: "available" });
			await journal.flush();
			await map.refresh(scope);
			expect(map.session(scope).model?.available).toBe(true);
			await chat.refresh(scope);
			expect(chat.session(scope).model?.available).toBe(true);
			map.emit(scope, "runtime", { type: "model.health", available: false, health: { status: "authentication_failure", reason: "secret", stack: "private" } });
			await journal.flush();
			const replay = new WorkspaceEventStream({ journal });
			await replay.refresh(scope);
			expect(replay.session(scope).model?.health).toEqual({ status: "authentication_failure" });
			expect(JSON.stringify(replay.events(scope))).not.toMatch(/secret|private/);
			expect(() => map.emit(scope, "runtime", { type: "model.health", available: true, health: { status: "provider_unavailable" } })).toThrow();
		} finally { await rm(directory, { recursive: true, force: true }); }
	});

});
