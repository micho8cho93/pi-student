import path from "node:path";
import type { SandboxCapability, SandboxConfig, SandboxEnvironmentState, SandboxProviderCapabilities } from "@pi-student/contracts";
import { Type, type Static } from "typebox";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SANDBOX_WORKSPACE, SandboxConfigurationError, resolveSandboxPath, type SandboxMode, type SandboxRuntime } from "./types.js";

export interface SandboxManagerOptions {
	mode?: SandboxMode;
	runtime?: SandboxRuntime;
	provider?: SandboxProvider;
}

/** Concrete providers live in adapter packages such as sandbox-gondolin. */
export interface SandboxProvider {
	create(mode: SandboxMode): SandboxRuntime;
	capabilities?(mode: SandboxMode): SandboxProviderCapabilities;
}

/** Owns backend selection and the lifecycle of one student's project sandbox. */
export class SandboxManager {
	readonly runtime: SandboxRuntime;
	private projectPath?: string;
	private configuration?: SandboxConfig;
	private state: SandboxEnvironmentState;

	constructor(private readonly initialProjectPath?: string, options: SandboxManagerOptions = {}) {
		this.runtime = options.runtime ?? options.provider?.create(options.mode ?? readSandboxMode()) ?? missingSandboxProvider();
		const capabilities = this.capabilities();
		this.state = {
			status: "configured",
			provider: capabilities.provider,
			capabilities,
			requiredCapabilities: [],
		};
	}

	async configure(configuration: SandboxConfig): Promise<void> {
		const nextState = this.inspect(configuration);
		if (nextState.status !== "configured" && nextState.status !== "ready") {
			this.state = nextState;
			throw new SandboxConfigurationError(nextState.message ?? "The selected coding environment is not usable.", configuration.mode, nextState.status, nextState.requiredCapabilities);
		}
		if (this.runtime.isRunning() && JSON.stringify(this.configuration) === JSON.stringify(configuration)) return;
		const wasRunning = this.runtime.isRunning();
		// The runtime validates and stages its own policy before stopping a VM. The
		// manager performs the capability handshake first, so unsupported profiles
		// cannot cause any lifecycle mutation here.
		if (this.runtime.configure) await this.runtime.configure(configuration);
		else if (configuration.profile) throw new Error("Sandbox provider cannot enforce this profile.");
		else if (wasRunning) await this.runtime.stop();
		this.configuration = configuration;
		this.state = { ...nextState, status: "ready" };
		if (wasRunning && this.projectPath) {
			try {
				await this.runtime.start(this.projectPath);
				this.state = { ...this.state, status: "active" };
			} catch (error) {
				this.state = { ...this.state, status: "failed", message: "The coding environment could not be restarted." };
				throw error;
			}
		}
	}

	async start(projectPath = this.initialProjectPath ?? process.cwd()): Promise<void> {
		this.projectPath = path.resolve(projectPath);
		try {
			await this.runtime.start(this.projectPath);
			this.state = { ...this.state, status: "active", message: undefined };
		} catch (error) {
			this.state = { ...this.state, status: "failed", message: "The coding environment could not be started." };
			throw error;
		}
	}

	async stop(): Promise<void> {
		await this.runtime.stop();
		if (this.state.status === "active") this.state = { ...this.state, status: this.configuration ? "ready" : "configured" };
	}

	isRunning(): boolean {
		return this.runtime.isRunning();
	}

	getEnvironmentState(): SandboxEnvironmentState {
		return this.state;
	}

	setEnvironmentState(state: SandboxEnvironmentState): void {
		this.state = state;
	}

	getCapabilities(): SandboxProviderCapabilities {
		return this.capabilities();
	}

	inspect(configuration: SandboxConfig): SandboxEnvironmentState {
		const capabilities = this.capabilities();
		const requiredCapabilities = requiredCapabilitiesFor(configuration);
		if (this.runtime.mode && this.runtime.mode !== configuration.mode) {
			return { status: "unsupported", provider: capabilities.provider, capabilities, requiredCapabilities,
				message: "The selected coding environment is not supported by the active sandbox provider." };
		}
		if (requiredCapabilities.length > 1 && !this.runtime.configure) {
			return { status: "unsupported", provider: capabilities.provider, capabilities, requiredCapabilities,
				message: "The active sandbox provider cannot apply the selected environment policy." };
		}
		const missing = requiredCapabilities.filter(capability => !capabilities.capabilities.includes(capability));
		if (missing.length) {
			return { status: "unsupported", provider: capabilities.provider, capabilities, requiredCapabilities,
				message: "This managed environment requires sandbox capabilities that are unavailable on this device." };
		}
		return { status: "ready", provider: capabilities.provider, capabilities, requiredCapabilities };
	}

	private capabilities(): SandboxProviderCapabilities {
		return this.runtime.getCapabilities?.() ?? {
			provider: "unknown",
			mode: this.runtime.mode ?? readSandboxMode(),
			capabilities: ["workspace"],
		};
	}
}

export function requiredCapabilitiesFor(configuration: SandboxConfig): SandboxCapability[] {
	const required: SandboxCapability[] = ["workspace"];
	if (configuration.internetAllowed !== undefined) required.push("internet-policy");
	if (configuration.blockedHosts?.length) required.push("blocked-hosts");
	if (configuration.profile) {
		required.push("managed-profile", "profile-image", "resource-limits");
		if (configuration.profile.datasets.length) required.push("datasets");
	}
	return [...new Set(required)];
}

export function readSandboxMode(env: NodeJS.ProcessEnv = process.env): SandboxMode {
	const requested = env.SANDBOX_MODE?.trim().toLowerCase();
	if (requested === "host") return "host";
	return "gondolin";
}

/**
 * Replace Pi's filesystem/process tools with adapters that use the runtime.
 * The built-in grep tool is not used because its SDK implementation starts a
 * host-side ripgrep process; the definition below searches through the runtime.
 */
export function createSandboxToolDefinitions(runtime: SandboxRuntime): ToolDefinition[] {
	const cwd = runtime.getWorkspacePath();
	const readOps = {
		readFile: async (filePath: string) => Buffer.from(runtime.readBytes ? await runtime.readBytes(filePath) : await runtime.readFile(filePath)),
		access: async (filePath: string) => {
			if (!(await runtime.fileExists(filePath))) throw new Error(`Path not found: ${filePath}`);
		},
	};
	const writeOps = {
		writeFile: (filePath: string, content: string) => runtime.writeFile(filePath, content),
		mkdir: async (directory: string) => {
			if (!runtime.mkdir) throw new Error("Sandbox runtime does not support directory creation");
			await runtime.mkdir(directory);
		},
	};
	const stat = async (filePath: string) => runtime.stat ? runtime.stat(filePath) : { isDirectory: () => false };

	const tools = [
		createReadTool(cwd, { operations: { ...readOps, detectImageMimeType: async (filePath) => detectImageMimeType(filePath) } }),
		createWriteTool(cwd, { operations: writeOps }),
		createEditTool(cwd, { operations: { ...readOps, ...writeOps } }),
		createBashTool(cwd, {
			exposeSessionEnvironment: false,
			operations: {
				exec: async (command, commandCwd, options) => {
					const result = await runtime.exec(command, {
						cwd: commandCwd,
						env: options.env,
						signal: options.signal,
						timeout: options.timeout,
						onData: options.onData,
					});
					return { exitCode: result.exitCode };
				},
			},
		}),
		createLsTool(cwd, {
			operations: {
				exists: (filePath) => runtime.fileExists(filePath),
				stat,
				readdir: async (directory) => runtime.listDirectory ? runtime.listDirectory(directory) : (await runtime.listFiles(directory)).map((filePath) => path.posix.basename(filePath)),
			},
		}),
		createFindTool(cwd, {
			operations: {
				exists: (filePath) => runtime.fileExists(filePath),
				glob: async (pattern, directory, options) => (await runtime.listFiles(directory))
					.filter((filePath) => matchesGlob(path.posix.relative(directory, filePath), pattern))
					.slice(0, options.limit),
			},
		}),
	];
	return tools.map((tool) => ({
		// Keep SDK metadata and argument preparation intact. InteractiveMode
		// pairs these named tools with its bordered shell/file/diff renderers.
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => (tool as { execute: (...args: any[]) => Promise<unknown> }).execute(toolCallId, params, signal, onUpdate) as any,
	}));
}

const SandboxGrepParamsSchema = Type.Object({
	pattern: Type.String(),
	path: Type.Optional(Type.String()),
	glob: Type.Optional(Type.String()),
	ignoreCase: Type.Optional(Type.Boolean()),
	literal: Type.Optional(Type.Boolean()),
	context: Type.Optional(Type.Number()),
	limit: Type.Optional(Type.Number()),
});
type SandboxGrepParams = Static<typeof SandboxGrepParamsSchema>;

export function createSandboxGrepTool(runtime: SandboxRuntime): ToolDefinition<typeof SandboxGrepParamsSchema> {
	return {
		name: "grep",
		label: "grep",
		description: "Search project files inside the sandbox for a pattern.",
		promptSnippet: "Search file contents for patterns (sandboxed)",
		parameters: SandboxGrepParamsSchema,
		async execute(_toolCallId, params, signal) {
			const grepParams = params as SandboxGrepParams;
			const searchPath = resolveSandboxPath(grepParams.path ?? ".");
			const files = await runtime.listFiles(searchPath);
			const flags = grepParams.ignoreCase ? "i" : "";
			const matcher = grepParams.literal
				? (line: string) => (grepParams.ignoreCase ? line.toLowerCase() : line).includes(grepParams.ignoreCase ? grepParams.pattern.toLowerCase() : grepParams.pattern)
				: (line: string) => new RegExp(grepParams.pattern, flags).test(line);
			const limit = Math.max(1, grepParams.limit ?? 100);
			const context = Math.max(0, grepParams.context ?? 0);
			const output: string[] = [];
			const maxBytes = 50 * 1024;
			let outputBytes = 0;
			let truncated = false;
			let matches = 0;
			search: for (const filePath of files) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const relativePath = path.posix.relative(searchPath, filePath) || path.posix.basename(filePath);
				if (grepParams.glob && !matchesGlob(relativePath, grepParams.glob)) continue;
				const lines = (await runtime.readFile(filePath)).replace(/\r\n/g, "\n").split("\n");
				for (let index = 0; index < lines.length; index++) {
					if (!matcher(lines[index] ?? "")) continue;
					matches++;
					const start = Math.max(0, index - context);
					const end = Math.min(lines.length - 1, index + context);
					for (let lineIndex = start; lineIndex <= end; lineIndex++) {
						const separator = lineIndex === index ? ":" : "-";
						const line = `${relativePath}${separator}${lineIndex + 1}${separator} ${lines[lineIndex] ?? ""}`;
						if (outputBytes + Buffer.byteLength(line) + 1 > maxBytes) {
							output.push(Buffer.from(line).subarray(0, Math.max(0, maxBytes - outputBytes - 4)).toString("utf8"));
							truncated = true;
							break search;
						}
						output.push(line);
						outputBytes += Buffer.byteLength(line) + 1;
					}
					if (matches >= limit) break;
				}
				if (matches >= limit) break;
			}
			return {
				content: [{ type: "text" as const, text: (output.length ? output.join("\n") : "No matches found") + (truncated ? "\n[Output truncated at 50 KB; narrow the search.]" : "") }],
				details: { ...(matches >= limit ? { matchLimitReached: limit } : {}), ...(truncated ? { truncated: true } : {}) },
			};
		},
	};
}

function detectImageMimeType(filePath: string): string | null {
	const extension = path.posix.extname(filePath).toLowerCase();
	if (extension === ".png") return "image/png";
	if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
	if (extension === ".gif") return "image/gif";
	if (extension === ".webp") return "image/webp";
	return null;
}

function matchesGlob(value: string, pattern: string): boolean {
	const normalizedValue = value.replaceAll("\\", "/");
	const normalizedPattern = pattern.replaceAll("\\", "/");
	const regex = globToRegex(normalizedPattern);
	return new RegExp(`^${regex}$`).test(normalizedValue) || (!normalizedPattern.includes("/") && new RegExp(`^${regex}$`).test(path.posix.basename(normalizedValue)));
}

function globToRegex(pattern: string): string {
	let result = "";
	for (let index = 0; index < pattern.length; index++) {
		const character = pattern[index];
		if (character === "*" && pattern[index + 1] === "*") {
			index++;
			if (pattern[index + 1] === "/") {
				index++;
				result += "(?:.*/)?";
			} else {
				result += ".*";
			}
		} else if (character === "*") {
			result += "[^/]*";
		} else if (character === "?") {
			result += "[^/]";
		} else {
			result += escapeRegExpCharacter(character);
		}
	}
	return result;
}

function escapeRegExpCharacter(value: string): string {
	return value.replace(/[.*+^${}()|[\]\\]/g, "\\$&");
}

function missingSandboxProvider(): never {
	throw new Error("A sandbox provider is required. The client composes the Gondolin provider at startup.");
}
