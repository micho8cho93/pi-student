import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir, type ModelRuntime } from "@earendil-works/pi-coding-agent";

export const OLLAMA_PROVIDER_ID = "ollama";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

interface OllamaConfig { url: string; modelId?: string }
interface OllamaTags { models: Array<{ name?: string; model?: string; details?: { family?: string } }> }

export type OllamaDiscoveryCode = "OLLAMA_OFFLINE" | "OLLAMA_TIMEOUT" | "OLLAMA_HTTP_ERROR" | "OLLAMA_INCOMPATIBLE" | "OLLAMA_INVALID_RESPONSE" | "OLLAMA_NO_MODELS";

export class OllamaDiscoveryError extends Error {
	constructor(readonly code: OllamaDiscoveryCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "OllamaDiscoveryError";
	}
}

export function ollamaConfigPath(): string {
	return join(getAgentDir(), "pi-student-ollama.json");
}

export function normalizeOllamaUrl(value: string): string {
	let url: URL;
	try { url = new URL(value.trim() || DEFAULT_OLLAMA_URL); }
	catch { throw new Error("Enter an Ollama URL such as http://127.0.0.1:11434."); }
	if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !["/", "/v1", "/v1/"].includes(url.pathname)) {
		throw new Error("Ollama must use a local HTTP address, such as http://127.0.0.1:11434.");
	}
	return url.origin;
}

export async function readOllamaConfig(path = ollamaConfigPath()): Promise<OllamaConfig | undefined> {
	try {
		const config = JSON.parse(await readFile(path, "utf8")) as OllamaConfig;
		return { url: normalizeOllamaUrl(config.url), modelId: typeof config.modelId === "string" ? config.modelId : undefined };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Could not read Ollama connection at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function readOllamaUrl(path = ollamaConfigPath()): Promise<string | undefined> {
	return (await readOllamaConfig(path))?.url;
}

export async function saveOllamaUrl(url: string, modelId: string, path = ollamaConfigPath()): Promise<void> {
	const normalized = normalizeOllamaUrl(url);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ url: normalized, modelId }, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

export async function registerOllama(runtime: ModelRuntime, url: string, fetchImpl: typeof fetch = fetch): Promise<readonly string[]> {
	const baseUrl = normalizeOllamaUrl(url);
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
	} catch (error) {
		const timedOut = error instanceof DOMException && error.name === "TimeoutError";
		throw new OllamaDiscoveryError(timedOut ? "OLLAMA_TIMEOUT" : "OLLAMA_OFFLINE",
			timedOut ? "Ollama did not respond within 5 seconds. Check that ollama serve is running." : "Ollama is offline. Start it with ollama serve, then try again.", { cause: error });
	}
	if (!response.ok) {
		const code = response.status === 404 || response.status === 405 ? "OLLAMA_INCOMPATIBLE" : "OLLAMA_HTTP_ERROR";
		throw new OllamaDiscoveryError(code, code === "OLLAMA_INCOMPATIBLE"
			? `The Ollama endpoint at ${baseUrl} does not provide /api/tags.`
			: `Ollama at ${baseUrl} returned HTTP ${response.status}.`);
	}
	let payload: unknown;
	try { payload = await response.json(); }
	catch (error) { throw new OllamaDiscoveryError("OLLAMA_INVALID_RESPONSE", "Ollama returned an invalid model list.", { cause: error }); }
	if (!payload || typeof payload !== "object" || !Array.isArray((payload as { models?: unknown }).models)) {
		throw new OllamaDiscoveryError("OLLAMA_INVALID_RESPONSE", "Ollama returned an invalid model list.");
	}
	const rows = (payload as OllamaTags).models;
	const models = [...new Set(rows.map(model => {
		if (!model || typeof model !== "object") throw new OllamaDiscoveryError("OLLAMA_INVALID_RESPONSE", "Ollama returned an invalid model list.");
		const name = typeof model.name === "string" ? model.name : typeof model.model === "string" ? model.model : "";
		const trimmed = name.trim();
		if (!trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed)) throw new OllamaDiscoveryError("OLLAMA_INVALID_RESPONSE", "Ollama returned an invalid model list.");
		return trimmed;
	}))];
	if (!models.length) throw new OllamaDiscoveryError("OLLAMA_NO_MODELS", "Ollama has no downloaded models. Run ollama pull <model>, then try again.");
	runtime.registerProvider(OLLAMA_PROVIDER_ID, {
		name: "Ollama (local)", api: "openai-completions", baseUrl: `${baseUrl}/v1`, apiKey: "ollama", authHeader: false,
		models: models.map(id => ({
			id, name: id, api: "openai-completions" as const, reasoning: false,
			input: ["text"] as ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000, maxTokens: 4_096,
			compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
		})),
	});
	return models;
}
