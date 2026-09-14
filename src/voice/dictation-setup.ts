import { spawn } from "node:child_process";
import { FileCredentialStore, persistApiKey } from "../pi/auth-storage.js";
import { DictationController, getVozCommand, hasVozCli, type DictationBackend } from "./dictation.js";
import { readDictationPreferences, saveDictationPreferences, type DictationProviderPreference } from "./dictation-config.js";

export interface DictationSetupUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	secret(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

const OPENAI_OPTION = "OpenAI transcription — best accuracy (recommended)";
const GROQ_OPTION = "Groq Whisper — fast cloud transcription";
const VOZ_OPTION = "Voz — private on-device transcription (Apple silicon)";
const LOCAL_OPTION = "Local Whisper — private, no audio upload (automatic)";
const KEEP_OPTION = "Keep the current setup";
const CANCEL_OPTION = "Cancel";

/** Guided setup used by both student terminals and the teacher terminal. */
export async function runDictationSetup(
	controller: DictationController,
	ui: DictationSetupUI,
	env: NodeJS.ProcessEnv = process.env,
): Promise<DictationBackend | undefined> {
	const current = await controller.getBackend();
	const choice = await ui.select(
		current ? `Dictation is ready with ${current.label}` : "Set up dictation",
		[
			...(current ? [KEEP_OPTION] : []),
			VOZ_OPTION,
			OPENAI_OPTION,
			GROQ_OPTION,
			LOCAL_OPTION,
			CANCEL_OPTION,
		],
	);
	if (!choice || choice === CANCEL_OPTION) return current;
	if (choice === KEEP_OPTION) {
		await reportReady(current!, ui);
		return current;
	}
	if (choice === VOZ_OPTION) {
		const saved = await readDictationPreferences(env);
		await saveDictationPreferences({ ...saved, provider: "voz", command: undefined }, env);
		const backend = await controller.getBackend();
		await reportReady(backend, ui);
		return backend;
	}

	if (choice === LOCAL_OPTION) {
		const saved = await readDictationPreferences(env);
		await saveDictationPreferences({ ...saved, provider: "local", command: undefined }, env);
		const backend = await controller.getBackend();
		await reportReady(backend, ui);
		return backend;
	}

	const provider: Exclude<DictationProviderPreference, "command"> = choice === GROQ_OPTION ? "groq" : "openai";
	const existingKey = await readExistingKey(provider, env);
	if (!existingKey) {
		const label = provider === "openai" ? "OpenAI API key" : "Groq API key";
		const key = (await ui.secret(label, provider === "openai" ? "sk-…" : "gsk_…"))?.trim();
		if (!key) return current;
		await persistApiKey(provider, key);
	}
	const saved = await readDictationPreferences(env);
	await saveDictationPreferences({ ...saved, provider }, env);
	const backend = await controller.getBackend();
	await reportReady(backend, ui);
	return backend;
}

async function readExistingKey(provider: "openai" | "groq", env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const envKey = provider === "openai" ? env.OPENAI_API_KEY : env.GROQ_API_KEY;
	if (envKey?.trim()) return envKey.trim();
	const credential = await new FileCredentialStore().read(provider);
	if (credential?.type !== "api_key") return undefined;
	const name = provider === "openai" ? "OPENAI_API_KEY" : "GROQ_API_KEY";
	return credential.key?.trim() || credential.env?.[name]?.trim() || undefined;
}

async function reportReady(backend: DictationBackend | undefined, ui: DictationSetupUI): Promise<void> {
	if (!backend) {
		ui.notify("Dictation setup was not completed.", "warning");
		return;
	}
	if (!(await hasFfmpeg())) {
		ui.notify(`Saved ${backend.label}, but ffmpeg is not installed. Install ffmpeg and restart Pi Student to record from the microphone.`, "warning");
		return;
	}
	if (backend.kind === "local") {
		ui.notify(`Saved ${backend.label}. The first recording downloads the ${backend.model} model automatically; later recordings stay on this device.`, "info");
		return;
	}
	if (backend.kind === "voz") {
		if (!await hasVozCli(backend.command)) {
			ui.notify(`Voz is not available in this Pi Student installation. Run \`pi-student repair\`, then try the shortcut again.`, "warning");
			return;
		}
		ui.notify(`Saved ${backend.label}. Pi Student downloads and caches the Voz model on first use.`, "info");
		return;
	}
	ui.notify(`Dictation is ready with ${backend.label}. Your next recording will be transcribed in the language you speak.`, "info");
}

export async function hasFfmpeg(): Promise<boolean> {
	return new Promise(resolve => {
		const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
		child.once("error", () => resolve(false));
		child.once("close", code => resolve(code === 0));
	});
}
