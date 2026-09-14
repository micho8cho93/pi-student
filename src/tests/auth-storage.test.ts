import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore, persistApiKey } from "../pi/auth-storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi credential storage", () => {
	it("persists provider keys outside project state with owner-only permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-student-auth-"));
		temporaryDirectories.push(directory);
		const authPath = join(directory, "auth.json");

		await persistApiKey("openai", "sk-test-secret-value", authPath);

		expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
			openai: { type: "api_key", key: "sk-test-secret-value" },
		});
		expect((await stat(authPath)).mode & 0o777).toBe(0o600);
	});

	it("preserves credentials for other providers during updates", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-student-auth-"));
		temporaryDirectories.push(directory);
		const authPath = join(directory, "auth.json");
		const store = new FileCredentialStore(authPath);

		await store.modify("anthropic", async () => ({ type: "api_key", key: "anthropic-secret" }));
		await store.modify("openai", async () => ({ type: "api_key", key: "openai-secret" }));

		expect((await store.list()).map(({ providerId, type }) => ({ providerId, type }))).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
	});
});
