import { createInterface, type Interface } from "node:readline/promises";
import { execFileSync } from "node:child_process";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { persistApiKey } from "./auth-storage.js";
import { DEFAULT_OLLAMA_URL, OLLAMA_PROVIDER_ID, readOllamaConfig, registerOllama, saveOllamaUrl } from "./ollama.js";
import { createTheme, indent, renderSetupHeader, type TerminalTheme } from "./ui.js";

export interface SetupIO {
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	readline?: Interface;
	/** Set when the caller refreshed the runtime before opening stdin. */
	skipRefresh?: boolean;
	/** Set when the caller already checked for an available configured model. */
	skipReadinessCheck?: boolean;
}

export interface ProviderSetupResult {
	providerId: string;
	modelId: string;
}

interface ProviderChoice {
	id: string;
	label: string;
	url?: string;
	oauth?: boolean;
	local?: boolean;
}

const PROVIDERS: readonly ProviderChoice[] = [
	{ id: OLLAMA_PROVIDER_ID, label: "Ollama (local)", local: true },
	{ id: "openai", label: "OpenAI", url: "https://platform.openai.com/api-keys" },
	{ id: "anthropic", label: "Anthropic", url: "https://console.anthropic.com/settings/keys" },
	{ id: "openai-codex", label: "OpenAI Codex", url: "https://chatgpt.com/", oauth: true },
	{ id: "google", label: "Google Gemini", url: "https://aistudio.google.com/apikey" },
	{ id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/keys" },
	{ id: "xai", label: "xAI", url: "https://console.x.ai/" },
	{ id: "mistral", label: "Mistral", url: "https://console.mistral.ai/api-keys/" },
	{ id: "groq", label: "Groq", url: "https://console.groq.com/keys" },
	{ id: "deepseek", label: "DeepSeek", url: "https://platform.deepseek.com/api_keys" },
];

export async function ensureProviderConfigured(runtime: ModelRuntime, io: SetupIO = {}): Promise<ProviderSetupResult> {
	const input = io.input ?? defaultInput;
	const output = io.output ?? defaultOutput;
	const theme = createTheme(output);
	if (!io.skipRefresh) await refreshRuntime(runtime);

	if (!io.skipReadinessCheck) {
		const ready = await findReadyProvider(runtime);
		if (ready) return ready;
	}

	const configured = availableProviderChoices(runtime).filter((choice) => runtime.getProviderAuthStatus(choice.id).configured);
	const ollamaSaved = Boolean(await readOllamaConfig());
	const reason = ollamaSaved && !runtime.getProvider(OLLAMA_PROVIDER_ID)
		? "Saved Ollama connection is unavailable. Start Ollama and check that it has a downloaded model."
		: configured.length > 0
		? "Pi found a configured provider, but it is not currently usable. You can replace its key below."
		: "No model provider is configured yet.";
	output.write(`${renderSetupHeader(theme)}${theme.warning(`  ${reason}`)}\n`);
	return runProviderSetup(runtime, { input, output, readline: io.readline, theme });
}

export async function runProviderSetup(
	runtime: ModelRuntime,
	io: SetupIO & { theme?: TerminalTheme } = {},
): Promise<ProviderSetupResult> {
	const input = io.input ?? defaultInput;
	const output = io.output ?? defaultOutput;
	const theme = io.theme ?? createTheme(output);
	const readline = io.readline ?? createInterface({ input, output });
	const ownsReadline = !io.readline;
	const lines = readline[Symbol.asyncIterator]();

	try {
		const choices = availableProviderChoices(runtime);
		output.write(`${theme.bold("Choose a provider")} ${theme.dim("(number, provider id, or q to quit)")}\n`);
		choices.forEach((choice, index) => {
			const status = runtime.getProviderAuthStatus(choice.id).configured
				? theme.success("configured")
				: choice.local ? theme.dim("runs on this computer")
				: "oauth" in choice && choice.oauth
					? theme.dim("OAuth / connector")
					: theme.dim("API key");
			output.write(`  ${theme.accent(String(index + 1))}. ${choice.label.padEnd(14)} ${status}\n`);
		});

		const choice = await askUntil(readline, lines, output, "\nProvider › ", (answer) => resolveChoice(answer, choices));
		if (!choice) throw new SetupCancelledError();

		const guide = choices.find((provider) => provider.id === choice.id)!;
		if (guide.local) {
			const defaultUrl = (await readOllamaConfig())?.url ?? DEFAULT_OLLAMA_URL;
			output.write(`\n${theme.muted("Start Ollama (ollama serve) and download a tool-capable model (ollama pull <model>) first.")}\n`);
			output.write(`Ollama address ${theme.dim(`(${defaultUrl}; Enter to use it)`)} › `);
			const answer = await lines.next();
			if (answer.done) throw new SetupCancelledError();
			let models: readonly string[];
			try {
				models = await registerOllama(runtime, answer.value.trim() || defaultUrl);
				await runtime.refresh({ allowNetwork: false, providers: [OLLAMA_PROVIDER_ID] });
			} catch (error) {
				output.write(`${theme.error(error instanceof Error ? error.message : String(error))}\n`);
				return runProviderSetup(runtime, { input, output, readline, theme });
			}
			output.write(`\n${theme.bold("Downloaded models")}\n`);
			models.forEach((id, index) => output.write(`  ${theme.accent(String(index + 1))}. ${id}\n`));
			const model = await askUntil(readline, lines, output, "\nModel › ", answer => resolveChoice(answer, models.map(id => ({ id, label: id }))));
			if (!model) throw new SetupCancelledError();
			await saveOllamaUrl(answer.value.trim() || defaultUrl, model.id);
			output.write(`${theme.success("✓ Ollama connected")} ${theme.dim(model.id)}\n`);
			return { providerId: OLLAMA_PROVIDER_ID, modelId: model.id };
		}
		if ("oauth" in guide && guide.oauth) return loginWithOAuth(runtime, choice.id, lines, input, output, theme);
		output.write(`\n${theme.muted(guide.url ? `${guide.label} API keys: ${guide.url}` : `${guide.label} uses the configured Pi provider credentials.`)}\n`);
		output.write(`${theme.dim("  Your key is stored in Pi's global auth.json (outside this project) and is never shown.")}\n`);
		const apiKey = await askSecret(lines, input, output, "API key › ");
		if (!apiKey.trim()) {
			output.write(`${theme.error("An API key is required to continue.")}\n`);
			return runProviderSetup(runtime, { input, output, readline, theme });
		}

		await persistApiKey(choice.id, apiKey.trim());
		await refreshRuntime(runtime, choice.id);
		const model = await pickModel(runtime, choice.id);
		if (!model) {
			output.write(`${theme.error(`Pi could not activate ${guide.label}'s models.`)}\n`);
			output.write(`${indent("The key was saved. Check that it is valid, has billing enabled, and is allowed to use the selected API.")}\n`);
			return runProviderSetup(runtime, { input, output, readline, theme });
		}
		output.write(`${theme.success("✓ API key saved")} ${theme.dim(`${guide.label} · ${model.id}`)}\n`);
		output.write(`${theme.dim("  The first message verifies provider access, billing, and model availability.")}\n`);
		return { providerId: choice.id, modelId: model.id };
	} finally {
		if (ownsReadline) readline.close();
	}
}

export class SetupCancelledError extends Error {
	constructor() {
		super("Provider setup cancelled");
		this.name = "SetupCancelledError";
	}
}

export async function pickModel(
	runtime: ModelRuntime,
	providerId: string,
): Promise<Awaited<ReturnType<ModelRuntime["getAvailable"]>>[number] | undefined> {
	const available = await runtime.getAvailable(providerId);
	if (providerId === OLLAMA_PROVIDER_ID) {
		const selected = (await readOllamaConfig())?.modelId;
		return available.find(model => model.id === selected) ?? available[0];
	}
	const preferred = ["gpt-4.1-mini", "claude-sonnet-4-5", "gemini-2.5-flash", "deepseek-chat"];
	return preferred.map((id) => available.find((model) => model.id === id)).find(Boolean) ?? available[0];
}

/** Run a provider's SDK-owned OAuth/connector flow without reimplementing it. */
export async function runOAuthSetup(
	runtime: ModelRuntime,
	io: SetupIO & { theme?: TerminalTheme } = {},
): Promise<ProviderSetupResult> {
	const input = io.input ?? defaultInput;
	const output = io.output ?? defaultOutput;
	const theme = io.theme ?? createTheme(output);
	const readline = io.readline ?? createInterface({ input, output });
	const ownsReadline = !io.readline;
	const lines = readline[Symbol.asyncIterator]();
	const providers = availableProviderChoices(runtime).filter((choice) => runtime.getProvider(choice.id)?.auth.oauth);
	try {
		if (providers.length === 0) throw new Error("No OAuth-capable provider is available in this Pi SDK configuration.");
		output.write(`\n${theme.bold("OAuth providers")} ${theme.dim("(number, provider id, or q to cancel)")}\n`);
		providers.forEach((provider, index) => output.write(`  ${theme.accent(String(index + 1))}. ${provider.label}\n`));
		const choice = await askUntil(readline, lines, output, "\nProvider › ", (answer) => resolveChoice(answer, providers));
		if (!choice) throw new SetupCancelledError();
		return loginWithOAuth(runtime, choice.id, lines, input, output, theme);
	} finally {
		if (ownsReadline) readline.close();
	}
}

export async function findReadyProvider(runtime: ModelRuntime): Promise<ProviderSetupResult | undefined> {
	for (const choice of availableProviderChoices(runtime)) {
		if (!runtime.getProviderAuthStatus(choice.id).configured) continue;
		const model = await pickModel(runtime, choice.id);
		if (model) return { providerId: choice.id, modelId: model.id };
	}
}

function availableProviderChoices(runtime: ModelRuntime) {
	const curated = PROVIDERS.filter((choice) => choice.local || runtime.getProvider(choice.id));
	const curatedIds = new Set(curated.map((choice) => choice.id));
	const configuredExtras = runtime.getProviders()
		.filter((provider) => !curatedIds.has(provider.id) && runtime.getProviderAuthStatus(provider.id).configured)
		.map((provider): ProviderChoice => ({ id: provider.id, label: provider.name, oauth: Boolean(provider.auth.oauth) }));
	return [...curated, ...configuredExtras];
}

async function loginWithOAuth(
	runtime: ModelRuntime,
	providerId: string,
	lines: AsyncIterator<string>,
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	theme: TerminalTheme,
): Promise<ProviderSetupResult> {
	const provider = runtime.getProvider(providerId);
	if (!provider?.auth.oauth) throw new Error(`${providerId} does not expose an OAuth flow in this Pi SDK.`);
	output.write(`\n${theme.muted(`Starting ${provider.name} sign-in through Pi...`)}\n`);
	await runtime.login(providerId, "oauth", {
		prompt: async (prompt) => {
			if (prompt.type === "select") {
				output.write(`${prompt.message}\n`);
				prompt.options.forEach((option, index) => output.write(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`));
			}
			const message = prompt.type === "select" ? "Selection › " : `${prompt.message} › `;
			if (prompt.type === "secret") return askSecret(lines, input, output, message);
			output.write(message);
			const next = await lines.next();
			if (next.done) throw new SetupCancelledError();
			if (prompt.type === "select") {
				const answer = next.value.trim();
				const index = Number(answer);
				return Number.isInteger(index) && index >= 1 && index <= prompt.options.length
					? prompt.options[index - 1].id
					: answer;
			}
			return next.value;
		},
		notify: (event) => {
			if (event.type === "auth_url") {
				output.write(`${theme.accent("Open this URL to continue:")}\n${indent(event.url)}\n`);
				if (event.instructions) output.write(`${indent(event.instructions)}\n`);
			} else if (event.type === "device_code") {
				output.write(`${theme.accent("Device sign-in")} ${event.userCode}\n${indent(event.verificationUri)}\n`);
			} else {
				output.write(`${theme.dim(event.message)}\n`);
			}
		},
	});
	await refreshRuntime(runtime, providerId);
	const model = await pickModel(runtime, providerId);
	if (!model) throw new Error(`Signed in to ${provider.name}, but no models are available.`);
	output.write(`${theme.success("✓ Signed in")} ${theme.dim(`${provider.name} · ${model.id}`)}\n`);
	return { providerId, modelId: model.id };
}

async function refreshRuntime(runtime: ModelRuntime, providerId?: string): Promise<void> {
	const result = await runtime.refresh({ allowNetwork: false, providers: providerId ? [providerId] : undefined });
	const error = providerId ? result.errors.get(providerId) : undefined;
	if (error) throw new Error(`Provider refresh failed: ${error.message}`);
}

function resolveChoice(answer: string, choices: ReadonlyArray<{ id: string; label: string }>) {
	const normalized = answer.trim().toLowerCase();
	if (normalized === "q" || normalized === "quit" || normalized === "exit") return undefined;
	const index = Number(normalized);
	if (Number.isInteger(index) && index >= 1 && index <= choices.length) return choices[index - 1];
	return choices.find((choice) => choice.id === normalized || choice.label.toLowerCase() === normalized);
}

async function askUntil<T>(
	readline: Interface,
	lines: AsyncIterator<string>,
	output: NodeJS.WritableStream,
	prompt: string,
	resolve: (answer: string) => T | undefined,
): Promise<T | undefined> {
	while (true) {
		output.write(prompt);
		const next = await lines.next();
		if (next.done) return undefined;
		const answer = next.value;
		const resolved = resolve(answer);
		if (resolved) return resolved;
		if (["q", "quit", "exit"].includes(answer.trim().toLowerCase())) return undefined;
		output.write("Please choose one of the listed providers.\n");
	}
}

export async function askSecret(
	lines: AsyncIterator<string>,
	input: NodeJS.ReadableStream,
	output: NodeJS.WritableStream,
	prompt: string,
): Promise<string> {
	const isTTY = Boolean((input as NodeJS.ReadStream & { isTTY?: boolean }).isTTY);
	output.write(prompt);
	if (!isTTY) {
		const next = await lines.next();
		return next.done ? "" : next.value;
	}

	let echoDisabled = false;
	try {
		execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
		echoDisabled = true;
		const next = await lines.next();
		const answer = next.done ? "" : next.value;
		output.write("\n");
		return answer;
	} finally {
		if (echoDisabled) execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
	}
}
