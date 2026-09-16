import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getInstallationPaths, type InstallationPaths } from "@pi-student/shared/installation-paths";

export const PASEO_PROVIDER_ID = "pi-student";
export const PASEO_LISTEN = "127.0.0.1:6767";
export const PASEO_URL = `http://${PASEO_LISTEN}`;
const RUNTIME_TOKEN = "__PI_STUDENT_RUNTIME__";

interface PaseoProviderConfig {
	extends?: string;
	label?: string;
	command?: string[];
	enabled?: boolean;
	paseoTools?: { enabled?: boolean };
}

interface PaseoSpeechEndpoint {
	apiKey?: string;
	baseUrl?: string;
}

export interface PaseoConfig {
	$schema?: string;
	version?: number;
	daemon?: {
		listen?: string;
		terminalProfiles?: unknown[];
		mcp?: { enabled?: boolean; injectIntoAgents?: boolean };
		relay?: { enabled?: boolean };
	};
	agents?: { providers?: Record<string, PaseoProviderConfig> };
	providers?: { openai?: { stt?: PaseoSpeechEndpoint } };
	features?: {
		dictation?: { enabled?: boolean; stt?: { provider?: string; model?: string } };
		voiceMode?: { enabled?: boolean };
		webUi?: { enabled?: boolean };
	};
}

export async function buildPaseoConfig(paths: InstallationPaths = getInstallationPaths()): Promise<PaseoConfig> {
	const templatePath = fileURLToPath(new URL("../config/config.json", import.meta.url));
	const source = await readFile(templatePath, "utf8");
	return JSON.parse(source.replaceAll(RUNTIME_TOKEN, paths.runtimeLauncher)) as PaseoConfig;
}

export async function writePaseoConfig(paths: InstallationPaths = getInstallationPaths()): Promise<void> {
	const config = await buildPaseoConfig(paths);
	const validation = validatePaseoConfig(config, paths);
	if (!validation.ok) throw new Error(validation.error);
	await mkdir(paths.paseoHome, { recursive: true, mode: 0o700 });
	await writeFile(paths.paseoConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function readAndValidatePaseoConfig(paths: InstallationPaths = getInstallationPaths()): Promise<{ ok: boolean; error?: string }> {
	try {
		const config = JSON.parse(await readFile(paths.paseoConfig, "utf8")) as PaseoConfig;
		return validatePaseoConfig(config, paths);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export function validatePaseoConfig(config: PaseoConfig, paths: InstallationPaths = getInstallationPaths()): { ok: boolean; error?: string } {
	const provider = config.agents?.providers?.[PASEO_PROVIDER_ID];
	if (config.version !== 1) return { ok: false, error: "Paseo configuration must use version 1." };
	if (config.daemon?.listen !== PASEO_LISTEN) return { ok: false, error: `Paseo must listen on ${PASEO_LISTEN}.` };
	if (config.daemon?.terminalProfiles?.length !== 0) return { ok: false, error: "Terminal profiles must remain disabled for Pi Student." };
	if (config.features?.webUi?.enabled !== true) return { ok: false, error: "Paseo's local web UI is not enabled." };
	if (config.features.dictation?.enabled !== true || config.features.voiceMode?.enabled !== false) {
		return { ok: false, error: "Paseo dictation must be enabled and voice mode must remain disabled." };
	}
	if (config.features.dictation.stt?.provider !== "openai" || config.features.dictation.stt.model !== "voz") {
		return { ok: false, error: "Paseo dictation must use the Voz transcription bridge." };
	}
	if (config.providers?.openai?.stt?.apiKey !== "pi-student-voz" || config.providers.openai.stt.baseUrl !== "http://127.0.0.1:6768/v1") {
		return { ok: false, error: "Paseo dictation must use the local Voz transcription bridge." };
	}
	if (config.daemon?.mcp?.enabled !== false || config.daemon.mcp.injectIntoAgents !== false) {
		return { ok: false, error: "Paseo tool injection must remain disabled for Pi Student." };
	}
	if (provider?.extends !== "pi" || provider.label !== "Pi Student") {
		return { ok: false, error: "The Pi Student Paseo provider is missing or invalid." };
	}
	if (provider.command?.length !== 1 || path.resolve(provider.command[0] ?? "") !== paths.runtimeLauncher) {
		return { ok: false, error: "The Paseo provider does not point to this Pi Student runtime." };
	}
	if (provider.paseoTools?.enabled !== false) {
		return { ok: false, error: "Paseo tools must remain disabled for the Pi Student provider." };
	}
	return { ok: true };
}
