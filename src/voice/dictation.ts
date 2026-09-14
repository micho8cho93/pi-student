import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { FileCredentialStore } from "../pi/auth-storage.js";
import { getInstallationPaths } from "../install/paths.js";
import { readDictationPreferences, type DictationPreferences, type DictationProviderPreference } from "./dictation-config.js";

export type DictationBackend =
	| { kind: "voz"; label: string; command: string; remote: false }
	| { kind: "openai" | "groq"; label: string; endpoint: string; model: string; apiKey: string; language?: string; remote: true }
	| { kind: "local"; label: string; model: string; language?: string; remote: false }
	| { kind: "command"; label: string; command: string; remote: false };

export interface DictationCredentialReader {
	read(providerId: string): Promise<unknown>;
}

export interface DictationStartOptions {
	allowRemote?: boolean;
	confirmRemote?: (backend: DictationBackend) => Promise<boolean>;
}

/**
 * A short-lived recorder/transcriber for student input. Audio is written to a
 * temp file only long enough to transcribe it, then removed in finally blocks.
 */
export class DictationController {
	private active?: { process: ChildProcess; completion: Promise<RecorderResult>; audioPath: string; backend: DictationBackend };
	private stopping?: Promise<string>;

	async getBackend(): Promise<DictationBackend | undefined> {
		return resolveDictationBackend();
	}

	async start(options: DictationStartOptions = {}): Promise<DictationBackend> {
		if (this.active) throw new Error("Dictation is already listening. Press the dictation shortcut again to stop it.");
		if (this.stopping) throw new Error("Dictation is still transcribing the previous recording.");

		const backend = await this.getBackend();
		if (!backend) throw new Error(dictationSetupMessage());
		if (backend.remote && options.allowRemote === false) throw new Error("This project allows on-device dictation only. Choose Voz or local transcription in dictation setup.");
		if (backend.remote && options.confirmRemote && !(await options.confirmRemote(backend))) {
			throw new DictationCancelledError();
		}

		const audioPath = join(tmpdir(), `pi-student-dictation-${randomUUID()}.wav`);
		try {
			const recording = await spawnRecorder(audioPath);
			this.active = { ...recording, audioPath, backend };
			return backend;
		} catch (error) {
			await removeAudio(audioPath);
			throw error;
		}
	}

	async stop(options: { allowRemote?: boolean } = {}): Promise<string> {
		if (this.stopping) return this.stopping;
		const active = this.active;
		if (!active) throw new Error("Dictation is not currently listening.");
		if (active.backend.remote && options.allowRemote === false) { await this.cancel(); throw new Error("This project allows on-device dictation only."); }
		this.active = undefined;
		this.stopping = this.finishRecording(active).finally(() => {
			this.stopping = undefined;
		});
		return this.stopping;
	}

	async cancel(): Promise<void> {
		const active = this.active;
		this.active = undefined;
		if (!active) return;
		active.process.kill("SIGTERM");
		await active.completion.catch(() => undefined);
		await removeAudio(active.audioPath);
	}

	isRecording(): boolean {
		return Boolean(this.active);
	}

	private async finishRecording(active: { process: ChildProcess; completion: Promise<RecorderResult>; audioPath: string; backend: DictationBackend }): Promise<string> {
		try {
			active.process.kill("SIGINT");
			const result = await active.completion;
			try {
				await readFile(active.audioPath);
			} catch (error) {
				if (isMissingFileError(error)) throw recorderFailure(result);
				throw error;
			}
			return await transcribeAudio(active.backend, active.audioPath);
		} finally {
			await removeAudio(active.audioPath);
		}
	}
}

export class DictationCancelledError extends Error {
	constructor() {
		super("Dictation cancelled.");
		this.name = "DictationCancelledError";
	}
}

export async function resolveDictationBackend(
	reader: DictationCredentialReader = new FileCredentialStore(),
	env: NodeJS.ProcessEnv = process.env,
	preferences?: DictationPreferences,
): Promise<DictationBackend | undefined> {
	const localCommand = env.PI_STUDENT_DICTATION_COMMAND?.trim();
	if (localCommand) return { kind: "command", label: "local transcription command", command: localCommand, remote: false };

	const explicitKey = env.PI_STUDENT_DICTATION_API_KEY?.trim();
	if (explicitKey) return openAiBackend(explicitKey, env);
	const saved = preferences ?? await readDictationPreferences(env);
	const preferred = providerPreference(env, saved);
	if (preferred === "voz") return vozBackend(env);
	if (preferred === "command" && saved.command) {
		return { kind: "command", label: "local transcription command", command: saved.command, remote: false };
	}
	if (preferred === "local") return localBackend(env, saved);
	if (await hasVozCli(env.PI_STUDENT_VOZ_COMMAND?.trim() || "da")) return vozBackend(env);

	const openAiKey = env.OPENAI_API_KEY?.trim() || await readApiKey(reader, "openai", "OPENAI_API_KEY");
	const groqKey = env.GROQ_API_KEY?.trim() || await readApiKey(reader, "groq", "GROQ_API_KEY");
	if (preferred === "groq" && groqKey) return groqBackend(groqKey, env, saved.language);
	if (preferred === "openai" && openAiKey) return openAiBackend(openAiKey, env, saved.language);
	if (openAiKey) return openAiBackend(openAiKey, env, saved.language);
	if (groqKey) return groqBackend(groqKey, env, saved.language);
	if (saved.command) return { kind: "command", label: "local transcription command", command: saved.command, remote: false };

	return undefined;
}

export function appendTranscript(existing: string, transcript: string): string {
	const current = existing.trim();
	const next = transcript.trim();
	if (!current) return next;
	if (!next) return current;
	return `${current}${/[\s\n]$/u.test(current) ? "" : " "}${next}`;
}

export function dictationSetupMessage(): string {
	return [
		"Dictation is not configured.",
		"Press Ctrl+Shift+D to set it up.",
		"Choose Voz on-device transcription (private, with a one-time model download), automatic local Whisper, or reuse an OpenAI/Groq API key already connected to Pi Student.",
	].join(" ");
}

function vozBackend(env: NodeJS.ProcessEnv): DictationBackend {
	return {
		kind: "voz",
		label: "Voz on-device transcription",
		command: getVozCommand(env),
		remote: false,
	};
}

export function getVozCommand(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_STUDENT_VOZ_COMMAND?.trim();
	if (override) return override;
	const bundled = join(getInstallationPaths(env).root, "runtime", "voz", "desertant");
	return existsSync(bundled) ? bundled : "da";
}

async function readApiKey(reader: DictationCredentialReader, providerId: string, envName: string): Promise<string | undefined> {
	const credential = await reader.read(providerId) as { type?: string; key?: string; env?: Record<string, string> } | undefined;
	if (credential?.type !== "api_key") return undefined;
	return credential.key?.trim() || credential.env?.[envName]?.trim() || undefined;
}

function openAiBackend(apiKey: string, env: NodeJS.ProcessEnv, language?: string): DictationBackend {
	const base = (env.PI_STUDENT_DICTATION_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/u, "");
	return {
		kind: "openai",
		label: "OpenAI transcription",
		endpoint: `${base}/audio/transcriptions`,
		model: env.PI_STUDENT_DICTATION_MODEL?.trim() || "gpt-4o-transcribe",
		apiKey,
		language: env.PI_STUDENT_DICTATION_LANGUAGE?.trim() || language,
		remote: true,
	};
}

function groqBackend(apiKey: string, env: NodeJS.ProcessEnv, language?: string): DictationBackend {
	return {
		kind: "groq",
		label: "Groq Whisper",
		endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
		model: env.PI_STUDENT_DICTATION_MODEL?.trim() || "whisper-large-v3-turbo",
		apiKey,
		language: env.PI_STUDENT_DICTATION_LANGUAGE?.trim() || language,
		remote: true,
	};
}

function localBackend(env: NodeJS.ProcessEnv, preferences: DictationPreferences): DictationBackend {
	return {
		kind: "local",
		label: "local Whisper transcription",
		model: env.PI_STUDENT_DICTATION_LOCAL_MODEL?.trim() || preferences.model || "Xenova/whisper-small",
		language: env.PI_STUDENT_DICTATION_LANGUAGE?.trim() || preferences.language,
		remote: false,
	};
}

function providerPreference(env: NodeJS.ProcessEnv, saved: DictationPreferences): DictationProviderPreference | undefined {
	const value = env.PI_STUDENT_DICTATION_PROVIDER?.trim().toLowerCase();
	return value === "voz" || value === "openai" || value === "groq" || value === "local" || value === "command" ? value : saved.provider;
}

interface RecorderResult {
	code: number | null;
	stderr: string;
}

async function spawnRecorder(audioPath: string): Promise<{ process: ChildProcess; completion: Promise<RecorderResult> }> {
	const args = process.platform === "darwin"
		? ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":default", "-ac", "1", "-ar", "16000", "-y", audioPath]
		: process.platform === "linux"
			? ["-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "default", "-ac", "1", "-ar", "16000", "-y", audioPath]
			: undefined;
	if (!args) throw new Error("Dictation currently supports macOS and Linux microphone capture.");

	const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", chunk => { stderr += chunk; });
	const completion = waitForProcess(child).then(code => ({ code, stderr }));
	// Keep a later microphone/ffmpeg failure from becoming an unhandled rejection
	// if the user has not pressed the stop shortcut yet.
	completion.catch(() => undefined);
	await new Promise<void>((resolve, reject) => {
		const onSpawn = () => {
			child.off("error", onError);
			resolve();
		};
		const onError = (error: NodeJS.ErrnoException) => {
			child.off("spawn", onSpawn);
			reject(error.code === "ENOENT" ? new Error("ffmpeg was not found. Install ffmpeg, then restart Pi Student.") : error);
		};
		child.once("spawn", onSpawn);
		child.once("error", onError);
	});
	return { process: child, completion };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function recorderFailure(result: RecorderResult): Error {
	const detail = result.stderr.trim();
	if (detail) return new Error(`Microphone recording failed: ${detail}`);
	if (result.code !== 0) return new Error(`Microphone recording failed: ffmpeg exited with code ${String(result.code)}.`);
	return new Error("Microphone recording failed: ffmpeg did not create an audio file.");
}

async function transcribeAudio(backend: DictationBackend, audioPath: string): Promise<string> {
	if (backend.kind === "voz") return transcribeWithVoz(backend.command, audioPath);
	if (backend.kind === "command") return transcribeWithCommand(backend.command, audioPath);
	if (backend.kind === "local") return transcribeWithLocalModel(backend, audioPath);

	const audio = await readFile(audioPath);
	const form = new FormData();
	form.append("file", new Blob([audio], { type: "audio/wav" }), basename(audioPath));
	form.append("model", backend.model);
	form.append("response_format", "json");
	if (backend.language) form.append("language", backend.language);
	const response = await fetch(backend.endpoint, {
		method: "POST",
		headers: { Authorization: `Bearer ${backend.apiKey}` },
		body: form,
	});
	const payload = await response.json().catch(() => undefined) as { text?: unknown; error?: { message?: unknown } } | undefined;
	if (!response.ok) {
		const detail = typeof payload?.error?.message === "string" ? payload.error.message : `HTTP ${response.status}`;
		throw new Error(`${backend.label} could not transcribe the recording: ${detail}`);
	}
	const text = typeof payload?.text === "string" ? payload.text.trim() : "";
	if (!text) throw new Error(`${backend.label} returned an empty transcript. Try speaking a little longer.`);
	return text;
}

let localTranscriber: Promise<(audio: Float32Array, options?: Record<string, unknown>) => Promise<{ text?: string }>> | undefined;

async function transcribeWithLocalModel(backend: Extract<DictationBackend, { kind: "local" }>, audioPath: string): Promise<string> {
	try {
		localTranscriber ??= loadLocalTranscriber(backend.model);
		const transcribe = await localTranscriber;
		const result = await transcribe(readWavSamples(await readFile(audioPath)), {
			chunk_length_s: 30,
			stride_length_s: 5,
			...(backend.language ? { language: backend.language } : {}),
		});
		const text = typeof result?.text === "string" ? result.text.trim() : "";
		if (!text) throw new Error("The local Whisper model returned an empty transcript. Try speaking a little longer.");
		return text;
	} catch (error) {
		localTranscriber = undefined;
		if (error instanceof Error && /Cannot find package|ERR_MODULE_NOT_FOUND/u.test(error.message)) {
			throw new Error("The local transcription runtime is unavailable. Reinstall Pi Student to include it, or choose another transcription provider in the dictation setup.");
		}
		throw new Error(`Local Whisper transcription failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function loadLocalTranscriber(model: string) {
	const { pipeline } = await import("@huggingface/transformers");
	const transcriber = await pipeline("automatic-speech-recognition", model);
	return async (audio: Float32Array, options?: Record<string, unknown>) => transcriber(audio, options as never) as Promise<{ text?: string }>;
}

function readWavSamples(buffer: Buffer): Float32Array {
	if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("The microphone recording is not a valid WAV file.");
	}
	let offset = 12;
	let channels = 1;
	let bitsPerSample = 16;
	let dataStart = -1;
	let dataSize = 0;
	while (offset + 8 <= buffer.length) {
		const chunkId = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		if (chunkId === "fmt " && size >= 16) {
			channels = buffer.readUInt16LE(offset + 10);
			bitsPerSample = buffer.readUInt16LE(offset + 22);
		}
		if (chunkId === "data") {
			dataStart = offset + 8;
			dataSize = Math.min(size, buffer.length - dataStart);
			break;
		}
		offset += 8 + size + (size % 2);
	}
	if (dataStart < 0 || channels < 1) throw new Error("The microphone recording does not contain PCM audio data.");
	const bytesPerSample = Math.max(1, Math.ceil(bitsPerSample / 8));
	const frameSize = bytesPerSample * channels;
	const samples = new Float32Array(Math.floor(dataSize / frameSize));
	for (let frame = 0; frame < samples.length; frame++) {
		let total = 0;
		for (let channel = 0; channel < channels; channel++) {
			const position = dataStart + frame * frameSize + channel * bytesPerSample;
			if (bitsPerSample === 8) total += (buffer.readUInt8(position) - 128) / 128;
			else if (bitsPerSample === 16) total += buffer.readInt16LE(position) / 32768;
			else if (bitsPerSample === 24) total += (buffer.readIntLE(position, 3) / 8388608);
			else if (bitsPerSample === 32) total += buffer.readInt32LE(position) / 2147483648;
			else throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}.`);
		}
		samples[frame] = total / channels;
	}
	return samples;
}

async function transcribeWithCommand(command: string, audioPath: string): Promise<string> {
	const child = spawn(command, [audioPath], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", chunk => { stdout += chunk; });
	child.stderr?.on("data", chunk => { stderr += chunk; });
	const code = await waitForProcess(child);
	if (code !== 0) throw new Error(`The local dictation command failed${stderr.trim() ? `: ${stderr.trim()}` : "."}`);
	const text = stdout.trim();
	if (!text) throw new Error("The local dictation command returned an empty transcript.");
	return text;
}

export async function transcribeWithVozAudio(audioPath: string, command = getVozCommand()): Promise<string> {
	return transcribeWithVoz(command, audioPath);
}

async function transcribeWithVoz(command: string, audioPath: string): Promise<string> {
	const child = spawn(command, ["voz", audioPath, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", chunk => { stdout += chunk; });
	child.stderr?.on("data", chunk => { stderr += chunk; });
	const code = await waitForProcess(child);
	if (code !== 0) {
		const detail = stderr.trim() || "Install Desert Ant's Voz CLI (`da`) on Apple silicon and try again.";
		throw new Error(`Voz transcription failed: ${detail}`);
	}
	let text = stdout.trim();
	try {
		const payload = JSON.parse(text) as { text?: unknown };
		if (typeof payload.text === "string") text = payload.text.trim();
	} catch {
		// Keep a plain-text response compatible with older Desert Ant builds.
	}
	if (!text) throw new Error("Voz returned an empty transcript. Try speaking a little longer.");
	return text;
}

export async function hasVozCli(command = "da"): Promise<boolean> {
	const child = spawn(command, ["info", "voz"], { stdio: "ignore" });
	return new Promise(resolve => {
		child.once("error", () => resolve(false));
		child.once("close", code => resolve(code === 0));
	});
}

function waitForProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			child.off("close", onClose);
			reject(error);
		};
		const onClose = (code: number | null) => {
			child.off("error", onError);
			resolve(code);
		};
		child.once("error", onError);
		child.once("close", onClose);
	});
}

async function removeAudio(audioPath: string): Promise<void> {
	await unlink(audioPath).catch(() => undefined);
}
