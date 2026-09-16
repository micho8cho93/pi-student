import { describe, expect, it } from "vitest";
import { appendTranscript, resolveDictationBackend } from "@pi-student/runtime/dictation";

describe("student dictation", () => {
	it("appends a transcript without damaging existing editor text", () => {
		expect(appendTranscript("Explain this", "using a simple example.")).toBe("Explain this using a simple example.");
		expect(appendTranscript("Explain this ", "using a simple example.")).toBe("Explain this using a simple example.");
		expect(appendTranscript("", "  hello  ")).toBe("hello");
	});

	it("prefers an explicitly configured local transcriber", async () => {
		const backend = await resolveDictationBackend({ read: async () => undefined }, {
			PI_STUDENT_DICTATION_COMMAND: "local-whisper",
		} as NodeJS.ProcessEnv, {});
		expect(backend).toEqual({ kind: "command", label: "local transcription command", command: "local-whisper", remote: false });
	});

	it("uses a stored OpenAI key when no local transcriber is configured", async () => {
		const backend = await resolveDictationBackend({
			read: async providerId => providerId === "openai" ? { type: "api_key", key: "secret" } : undefined,
		}, {}, {});
		expect(backend).toMatchObject({ kind: "openai", model: "gpt-4o-transcribe", remote: true, apiKey: "secret" });
	});

	it("honors the provider chosen by guided setup", async () => {
		const backend = await resolveDictationBackend({
			read: async providerId => ({ type: "api_key", key: `${providerId}-secret` }),
		}, {}, { provider: "groq" });
		expect(backend).toMatchObject({ kind: "groq", model: "whisper-large-v3-turbo", apiKey: "groq-secret" });
	});

	it("uses automatic local Whisper when local mode is remembered", async () => {
		const backend = await resolveDictationBackend({ read: async () => undefined }, {}, { provider: "local" });
		expect(backend).toMatchObject({ kind: "local", model: "Xenova/whisper-small", remote: false });
	});

	it("uses standard provider environment variables", async () => {
		const backend = await resolveDictationBackend({ read: async () => undefined }, {
			OPENAI_API_KEY: "from-environment",
		} as NodeJS.ProcessEnv, {});
		expect(backend).toMatchObject({ kind: "openai", apiKey: "from-environment" });
	});
});
