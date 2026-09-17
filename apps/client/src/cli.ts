#!/usr/bin/env node

import process from "node:process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { runVozBridge } from "@pi-student/paseo-adapter/voz-bridge";
import { initTheme, InteractiveMode, runRpcMode } from "@earendil-works/pi-coding-agent";
import { createLearningAgentRuntime, createLearningAgentSession, createStudentRuntime, DirectModelProvider, FileTeacherContextStore, StoredPolicyProvider } from "@pi-student/sdk";
import { createRuntimeSessionManager, parseStudentRuntimeArgs, splitModelId } from "@pi-student/runtime/runtime-args";
import { runRepl } from "./terminal/repl.js";
import { ensureProviderConfigured, findReadyProvider, SetupCancelledError } from "@pi-student/runtime/setup";
import { redactSecrets } from "@pi-student/runtime/ui";
import { readSandboxMode } from "@pi-student/sdk/sandbox";
import { SandboxRuntimeError } from "@pi-student/sandbox/types";
import { GondolinSandboxProvider } from "@pi-student/sandbox-gondolin/provider";
import { runDoctor } from "./install/doctor.js";
import { runRepair } from "./install/repair.js";
import { appendDiagnosticLog } from "./install/logging.js";
import { createLearningSession } from "@pi-student/education/types";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { authenticateInBrowser, createPiSupabaseClient, readSupabaseConfig, saveSupabaseConfig, SupabaseClassroomRepository, SupabaseGovernancePolicyProvider, SupabaseIdentityProvider, SupabaseInstitutionalEnvironmentProvider, SupabaseModelAdmissionProvider, SupabaseTelemetrySink } from "@pi-student/supabase-adapter";
import { launchPaseoGui } from "@pi-student/paseo-adapter/launcher";
import { createStartupCueLoader } from "@pi-student/runtime/progress";
import { disablePiStudentSlashCommands, isDisabledStudentSlashCommand } from "./terminal/slash-commands.js";
import { runPublishingCommand } from "./publishing-commands.js";
import { runEcosystemBridge } from "@pi-student/paseo-adapter/ecosystem-bridge";

const CLIENT_RUNTIME_ENTRY = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

async function main(): Promise<void> {
	loadProjectEnv();
	await disablePiStudentSlashCommands();
	let [command, ...flags] = process.argv.slice(2);
	if (!command) {
		command = process.stdin.isTTY && process.stdout.isTTY ? await chooseInterface() : "terminal";
	}
	if (command === "terminal" || command === "tui") {
		await runTerminal(flags);
		return;
	}
	if (command === "gui" || command === "web") {
		if (flags.length) throw new Error(`Unknown GUI option: ${flags[0]}`);
		await ensureGuiProviderConfigured();
		await launchPaseoGui({ runtimeEntry: CLIENT_RUNTIME_ENTRY });
		return;
	}
	if (command === "runtime") {
		await runSharedRuntime(flags);
		return;
	}
	if (command === "voz-bridge") {
		await runVozBridge(Number(process.env.PI_STUDENT_VOZ_BRIDGE_PORT) || undefined);
		return;
	}
	if (command === "ecosystem-bridge") {
		await runEcosystemBridge(Number(process.env.PI_STUDENT_ECOSYSTEM_BRIDGE_PORT) || undefined);
		return;
	}
	if (command === "doctor") {
		process.exitCode = await runDoctor({ verbose: flags.includes("--verbose") }) ? 0 : 1;
		return;
	}
	if (command === "repair") {
		process.exitCode = await runRepair({ verbose: flags.includes("--verbose") }) ? 0 : 1;
		return;
	}
	if (command && await runPublishingCommand([command, ...flags])) return;
	if (command && await runBundledTeacherCommand([command, ...flags])) return;
	if (command === "--unsafe-no-sandbox") {
		await runTerminal([command]);
		return;
	}
	if (command && command !== "--help" && command !== "-h") {
		throw new Error(`Unknown command: ${command}`);
	}
	if (command === "--help" || command === "-h") {
		process.stdout.write([
			"Usage: pi-student [terminal|gui]",
			"       pi-student [doctor|repair] [--verbose]",
			"       pi-student publish [--yes]",
			"       pi-student github [connect|status|repositories]",
			"       pi-student deployments",
			"       pi-student terminal --unsafe-no-sandbox",
			"       pi-student auth login google",
			"       pi-student auth [status|logout]",
			"       pi-student class [join <code>|list|select <class-id>]",
			"       pi-student project [list|select <project-id>]",
			"       pi-student sync",
			"       pi-student teacher [tui] [--port <number>]",
			"       pi-student teacher web [--port <number>]",
			"       pi-student teacher auth login google",
			"       pi-student teacher class [create <name>|list|members <id>|approve <membership-id>|reject <membership-id>|regenerate <id>|pause <id>|resume <id>]",
			"       pi-student teacher project [list <class-id>|create <class-id> <name>|requirement <project-id> <title>|standard <class-id> <project-id> <code> [title]]",
			"",
		].join("\n"));
		return;
	}
	await runTerminal([]);
}

/**
 * The curl artifact still carries the local teacher console for compatibility,
 * but the client workspace deliberately has no build-time dependency on it.
 * A future hosted teacher deployment can therefore replace this optional
 * integration without changing the student runtime or its dependency graph.
 */
async function runBundledTeacherCommand(args: string[]): Promise<boolean> {
	if (!["teacher", "auth", "class", "project", "sync"].includes(args[0] ?? "")) return false;
	try {
		const loadOptionalModule = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ runTeacherCommand(args: string[]): Promise<boolean> }>;
		return await (await loadOptionalModule("@pi-student/teacher-console/commands")).runTeacherCommand(args);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
			throw new Error("The local teacher console is not installed. Install the teacher-console deployment unit or use the hosted console when available.", { cause: error });
		}
		throw error;
	}
}

async function runTerminal(flags: string[]): Promise<void> {
	const unsafe = flags.includes("--unsafe-no-sandbox");
	const unknown = flags.find((flag) => flag !== "--unsafe-no-sandbox");
	if (unknown) throw new Error(`Unknown terminal option: ${unknown}`);
	if (unsafe) {
		process.env.SANDBOX_MODE = "host";
		process.stderr.write("WARNING: unsafe developer mode enabled; project commands run on this computer.\n");
	}
	const cwd = process.cwd();
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const startupCues = createStartupCueLoader(process.stdout);
	if (readSandboxMode() === "host" && !unsafe) {
		process.stderr.write("WARNING: SANDBOX_MODE=host is unsafe; project commands run on this computer.\n");
	}
	startupCues.start();
	const studentRuntime = await createApplicationRuntime(cwd);
	try {
	await studentRuntime.start();
	const modelRuntime = studentRuntime.modelRuntime;
	// Finish the async catalog/auth snapshot before attaching readline. This
	// prevents piped first-run input from being consumed while the runtime loads.
	await modelRuntime.refresh({ allowNetwork: false });
	const ready = await findReadyProvider(modelRuntime);
	if (!ready) startupCues.stop("Provider setup needed");
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	let setup;
	try {
		setup = ready ?? await ensureProviderConfigured(modelRuntime, {
			input: process.stdin,
			output: process.stdout,
			readline: terminal,
			skipRefresh: true,
			skipReadinessCheck: true,
		});
	} catch (error) {
		if (error instanceof SetupCancelledError) {
			process.stdout.write("\nSetup cancelled. Run pi-student again when you are ready to connect a provider.\n");
			terminal.close();
			return;
		}
		terminal.close();
		throw error;
	}
	const model = modelRuntime.getModel(setup.providerId, setup.modelId);
	if (!model) throw new Error(`Configured model ${setup.providerId}/${setup.modelId} is unavailable.`);
	const workflow = new WorkflowController(createLearningSession(cwd));
		if (interactive) {
			terminal.close();
			const agent = await createLearningAgentRuntime(cwd, workflow, modelRuntime, model, studentRuntime.sandbox, { services: studentRuntime.services });
			startupCues.stop("Pi Student is ready");
			const tui = new InteractiveMode(agent.runtime, {
				tuiMode: "fullscreen",
				startupDiagnostics: [
					{
						type: "info",
						message: "Pi Student is ready · Ctrl+Shift+D starts/stops dictation · /join-class to join your course · /help lists commands",
					},
				],
			});
			suppressStartupResourceInventory(tui);
			// Student mode keeps model reasoning internal; useful tool cards and concise
			// action statuses remain visible in the transcript.
			agent.runtime.services.settingsManager.setHideThinkingBlock(true);
			try {
				await tui.init();
				installInteractiveSlashCommandGuard(tui);
				await tui.run();
			} finally {
				await agent.dispose();
			}
			return;
		}

		const agent = await createLearningAgentSession(cwd, workflow, modelRuntime, model, studentRuntime.sandbox, { services: studentRuntime.services });
		startupCues.stop("Pi Student is ready");
		try {
			await runRepl({ workflow, agent, modelRuntime, inputReader: terminal });
		} finally {
			agent.dispose();
		}
	} finally {
		startupCues.stop("Pi Student stopped");
		await studentRuntime.dispose();
	}
	}

function suppressStartupResourceInventory(tui: InteractiveMode): void {
	// Pi currently has no public option to hide the loaded-resource sections.
	// Keep resources loaded for the agent, but omit their inventory from the
	// student-facing TUI, including the render after extension binding.
	(tui as unknown as { showLoadedResources: (...args: unknown[]) => void }).showLoadedResources = () => {};
}

function installInteractiveSlashCommandGuard(tui: InteractiveMode): void {
	const internal = tui as unknown as {
		defaultEditor?: {
			onSubmit?: (text: string) => void | Promise<void>;
			setText(text: string): void;
		};
		showWarning?: (message: string) => void;
	};
	const editor = internal.defaultEditor;
	const originalSubmit = editor?.onSubmit;
	if (!editor || !originalSubmit) return;
	editor.onSubmit = async (text) => {
		if (isDisabledStudentSlashCommand(text)) {
			editor.setText("");
			internal.showWarning?.("That slash command is not available in Pi Student.");
			return;
		}
		await originalSubmit(text);
	};
}

async function runSharedRuntime(flags: string[]): Promise<void> {
	const args = parseStudentRuntimeArgs(flags);
	const cwd = process.cwd();
	const studentRuntime = await createApplicationRuntime(cwd);
	await studentRuntime.start();
	let handedToRpc = false;
	try {
		const modelRuntime = studentRuntime.modelRuntime;
		await modelRuntime.refresh({ allowNetwork: false });
		const requested = args.model ? splitModelId(args.model) : undefined;
		const ready = requested ? undefined : await findReadyProvider(modelRuntime);
		const model = requested
			? modelRuntime.getModel(requested.provider, requested.modelId)
			: ready ? modelRuntime.getModel(ready.providerId, ready.modelId) : undefined;
		if (requested && !model) throw new Error(`Configured model ${args.model} is unavailable.`);
		const thinkingLevel = parseThinkingLevel(args.thinking);
		const workflow = new WorkflowController(createLearningSession(cwd));
		const agent = await createLearningAgentRuntime(cwd, workflow, modelRuntime, model, studentRuntime.sandbox, {
			sessionManager: createRuntimeSessionManager(cwd, args),
			thinkingLevel,
			services: studentRuntime.services,
		});
		initTheme(agent.runtime.services.settingsManager.getTheme(), false);
		handedToRpc = true;
		await runRpcMode(agent.runtime);
	} finally {
		if (!handedToRpc) await studentRuntime.dispose();
	}
}

async function ensureGuiProviderConfigured(): Promise<void> {
	const modelRuntime = (await DirectModelProvider.create()).runtime;
	await modelRuntime.refresh({ allowNetwork: false });
	if (await findReadyProvider(modelRuntime)) return;
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		throw new Error("Pi Student needs a model provider before the GUI can start. Run pi-student terminal once to complete setup.");
	}
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	try {
		await ensureProviderConfigured(modelRuntime, {
			input: process.stdin,
			output: process.stdout,
			readline: terminal,
			skipRefresh: true,
			skipReadinessCheck: true,
		});
	} catch (error) {
		if (error instanceof SetupCancelledError) {
			throw new Error("Provider setup was cancelled. Run pi-student gui when you are ready to continue.");
		}
		throw error;
	} finally {
		terminal.close();
	}
}

async function createApplicationRuntime(projectPath: string) {
	const modelProvider = await DirectModelProvider.create();
	const contextStore = new FileTeacherContextStore();
	const config = readSupabaseConfig();
	if (!config) {
		return createStudentRuntime({
			projectPath,
			modelProvider,
			sandboxProvider: new GondolinSandboxProvider(),
			identityProvider: { getIdentity: async () => ({ kind: "personal" as const }) },
			policyProvider: new StoredPolicyProvider(() => contextStore.read()),
		});
	}
	const client = createPiSupabaseClient(config);
	const identityProvider = new SupabaseIdentityProvider(client, "student");
	const gatewayUrl = process.env.PI_STUDENT_MODEL_GATEWAY_URL?.trim();
	return createStudentRuntime({
		projectPath,
		modelProvider,
		sandboxProvider: new GondolinSandboxProvider(),
		identityProvider,
		environmentProvider: new SupabaseInstitutionalEnvironmentProvider(client),
		policyProvider: new SupabaseGovernancePolicyProvider(client, new StoredPolicyProvider(() => contextStore.read()), gatewayUrl ? {
			url: gatewayUrl, configure: (projectId, url, profiles, token) => modelProvider.configureHostedProfiles(projectId, url, profiles, token),
		} : undefined),
		modelAdmission: new SupabaseModelAdmissionProvider(client, (token, sessionId, thinkingLevel) => modelProvider.refreshHostedToken(token, sessionId, thinkingLevel)),
		telemetrySink: new SupabaseTelemetrySink(client),
		classroom: {
			repository: new SupabaseClassroomRepository(client),
			identityProvider,
			contextStore,
			authenticator: { signIn: notify => authenticateInBrowser(client, notify) },
		},
	});
}

async function chooseInterface(): Promise<"terminal" | "gui"> {
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	process.stdout.write("Pi Student\n\nChoose an interface:\n\n1. Terminal\n2. GUI\n\n");
	try {
		while (true) {
			const choice = normalizeInterfaceChoice(await terminal.question("> "));
			if (choice) return choice;
			process.stdout.write("Choose 1 for Terminal or 2 for GUI.\n");
		}
	} finally {
		terminal.close();
	}
}

export function normalizeInterfaceChoice(value: string): "terminal" | "gui" | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "1" || normalized === "terminal" || normalized === "tui") return "terminal";
	if (normalized === "2" || normalized === "gui" || normalized === "web") return "gui";
	return undefined;
}

function parseThinkingLevel(value?: string): Parameters<import("@earendil-works/pi-coding-agent").AgentSession["setThinkingLevel"]>[0] | undefined {
	if (!value) return undefined;
	const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	if (!allowed.includes(value as typeof allowed[number])) throw new Error(`Unsupported thinking level: ${value}`);
	return value as typeof allowed[number];
}

/** Load the repository-local Supabase connection without requiring users to
 * export credentials in every shell. The file is intentionally gitignored;
 * the publishable key is safe for client use, while service-role keys are
 * never accepted by this app. */
function loadProjectEnv(): void {
	const envPath = join(process.cwd(), ".env.local");
	if (existsSync(envPath)) {
		process.loadEnvFile(envPath);
		const config = readSupabaseConfig();
		if (config) saveSupabaseConfig(config);
	}
}

try {
	await main();
} catch (error) {
	const message = redactSecrets(error instanceof Error ? error.message : String(error));
	const sandboxFailure = error instanceof SandboxRuntimeError || /secure coding|sandbox|gondolin|qemu|krun/i.test(message);
	if (sandboxFailure) {
		const logPath = await appendDiagnosticLog("runtime", message).catch(() => undefined);
		process.stderr.write(`Pi Student could not start its secure coding environment.\n\nRun:\n  pi-student doctor\n\nfor more information.${logPath ? `\n\nDiagnostic log:\n  ${logPath}` : ""}\n`);
	} else {
		process.stderr.write(`Pi Student could not start: ${message}\n`);
	}
	process.exitCode = 1;
}
