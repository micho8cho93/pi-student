import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDictationPreferences, saveDictationPreferences } from "../voice/dictation-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("dictation preferences", () => {
	it("persists the selected provider and local command outside the project", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-student-dictation-config-"));
		temporaryDirectories.push(directory);
		const filePath = join(directory, "config", "dictation.json");
		await saveDictationPreferences({ provider: "command", command: "whisper-local --model small" }, {}, filePath);

		expect(await readDictationPreferences({}, filePath)).toEqual({
			provider: "command",
			command: "whisper-local --model small",
			language: undefined,
		});
		expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ provider: "command" });
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);
	});
});
