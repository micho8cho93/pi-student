import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { initTheme, type ModelRuntime, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowController } from "@pi-student/education/workflow-controller";
import type { LearningAgentSession } from "@pi-student/runtime/create-session";
import { askSecret, pickModel, runOAuthSetup, runProviderSetup } from "@pi-student/runtime/setup";
import {
	createTheme,
	formatProviderError,
	renderAssistantLabel,
	renderPanel,
	renderUserLabel,
	renderWorkNotesLabel,
	type TerminalTheme,
} from "@pi-student/runtime/ui";
import { BUNDLED_THEME_NAMES, DEFAULT_THEME, resolveThemeAlias } from "@pi-student/runtime/themes";
import { createTerminalWorkingProgress, LEARNING_CUES, toolLearningCue } from "@pi-student/runtime/progress";
import { isDisabledStudentSlashCommand } from "./slash-commands.js";

export interface ReplOptions {
	workflow: WorkflowController;
	agent: LearningAgentSession;
	modelRuntime?: ModelRuntime;
	inputReader?: Interface;
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
}

export async function runRepl({
	workflow,
	agent,
	modelRuntime = agent.session.modelRuntime,
	input: inputStream = input,
	output: outputStream = output,
	inputReader,
}: ReplOptions): Promise<void> {
	const readline = inputReader ?? createInterface({ input: inputStream, output: outputStream });
	const ownsReadline = !inputReader;
	const lines = readline[Symbol.asyncIterator]();
	let activeTheme = agent.session.settingsManager?.getTheme?.() ?? DEFAULT_THEME;
	let theme = createTheme(outputStream, activeTheme);
	const write = (text: string) => outputStream.write(text);
	const workingProgress = createTerminalWorkingProgress(outputStream);
	if (agent.session.bindExtensions) {
		initTheme(agent.session.settingsManager.getTheme(), false);
		await agent.session.bindExtensions({
			mode: "print",
			uiContext: createReplUI(agent.session.extensionRunner.getUIContext(), lines, write),
		});
	}

	const model = agent.session.model;
	write(`\n${renderPanel(theme, "Pi Student · guided coding workspace", [
		{ label: "project", value: workflow.state.cwd },
		{ label: "learning", value: `${workflow.state.intent ?? "ROUTING"} · ${workflow.getStage().toUpperCase()}`, tone: "accent" },
		{ label: "plan", value: planProgressText(workflow) },
		{ label: "model", value: model ? `${model.provider}/${model.id}` : "none" },
	])}\n`);

	let assistantOpen = false;
	let workNotesOpen = false;
	let pendingProviderError: string | undefined;
	const unsubscribe = agent.session.subscribe((event) => {
		if (event.type === "agent_start") workingProgress.start();
		if (event.type === "turn_start") workingProgress.phase(LEARNING_CUES[2]);
		if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_start") workingProgress.phase(LEARNING_CUES[2]);
		if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") {
			workingProgress.stop();
			if (!workNotesOpen) {
				write(renderWorkNotesLabel(theme));
				workNotesOpen = true;
			}
			write(theme.dim(event.assistantMessageEvent.delta));
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_end" && workNotesOpen) {
			write("\n");
			workNotesOpen = false;
		}
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_start") workingProgress.phase(LEARNING_CUES[5]);
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			workingProgress.stop();
			if (workNotesOpen) {
				write("\n");
				workNotesOpen = false;
			}
			if (!assistantOpen) {
				write(renderAssistantLabel(theme));
				assistantOpen = true;
			}
			write(event.assistantMessageEvent.delta);
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			if (workNotesOpen) {
				write("\n");
				workNotesOpen = false;
			}
			if (assistantOpen) {
				write("\n");
				assistantOpen = false;
			}
			if (event.message.stopReason === "error") {
				pendingProviderError = event.message.errorMessage ?? "The provider ended the response with an unknown error.";
			}
		}
		if (event.type === "auto_retry_start") {
			write(`${theme.warning("↻ Retrying")} ${theme.dim(`attempt ${event.attempt}/${event.maxAttempts}`)}\n`);
		}
		if (event.type === "agent_end" && !event.willRetry) {
			workingProgress.stop();
			if (pendingProviderError) {
				write(`${formatProviderError(pendingProviderError, theme)}\n`);
				pendingProviderError = undefined;
			}
		}
		if (event.type === "tool_execution_start") {
			workingProgress.start();
			workingProgress.phase(toolLearningCue(event.toolName));
			if (workNotesOpen) {
				write("\n");
				workNotesOpen = false;
			}
			workingProgress.writeLine(`${theme.muted("·")} ${theme.dim(`using ${event.toolName}`)}`);
		}
		if (event.type === "tool_execution_end") {
			const status = event.isError ? theme.error("✗") : theme.success("✓");
			workingProgress.writeLine(`${status} ${theme.dim(`${event.toolName} ${event.isError ? "failed" : "finished"}`)}`);
		}
	});

	try {
		while (true) {
			outputStream.write(`\n${theme.accent("›")} `);
			const next = await lines.next();
			if (next.done) break;
			const line = next.value;
			let message = line.trim();
			if (!message) continue;
			const [command, ...args] = message.split(/\s+/u);
			if (command === "/quit" || command === "/exit") break;
			if (command === "/help") {
				write(formatHelp(theme));
				continue;
			}
			if (isDisabledStudentSlashCommand(message)) {
				write(`${theme.warning("That slash command is not available in Pi Student.")}\n`);
				continue;
			}
			if (command === "/model") {
				await handleModelCommand(args[0], agent, modelRuntime, theme, write);
				continue;
			}
			if (command === "/theme") {
				const requested = normalizeThemeName(args[0]);
				if (!requested) {
					write(`${renderPanel(theme, "Themes", [
						{ label: "active", value: activeTheme, tone: "success" },
						...BUNDLED_THEME_NAMES.map((name) => ({ label: "", value: name, tone: name === activeTheme ? "success" as const : "muted" as const })),
						{ label: "switch", value: "/theme <name>", tone: "accent" },
					])}\n`);
					continue;
				}
				if (!BUNDLED_THEME_NAMES.includes(requested as (typeof BUNDLED_THEME_NAMES)[number])) {
					write(`${theme.error(`Unknown theme: ${args[0]}`)}\n${theme.dim(`Available: ${BUNDLED_THEME_NAMES.join(", ")}`)}\n`);
					continue;
				}
				activeTheme = requested;
				theme = createTheme(outputStream, activeTheme);
				agent.session.settingsManager?.setTheme?.(activeTheme);
				write(`${theme.success("✓ Theme changed")} ${activeTheme}\n`);
				continue;
			}
			if (command === "/settings" || command === "/setup") {
				try {
					const selection = await runProviderSetup(modelRuntime, { input: inputStream, output: outputStream, readline, theme });
					const selectedModel = modelRuntime.getModel(selection.providerId, selection.modelId);
					if (selectedModel) await agent.session.setModel(selectedModel, { persist: true });
					write(`${theme.success("✓ Settings updated")}\n`);
				} catch (error) {
					write(`${theme.error(error instanceof Error ? error.message : String(error))}\n`);
				}
				continue;
			}
			if (command === "/login") {
				try {
					const selection = await runOAuthSetup(modelRuntime, { input: inputStream, output: outputStream, readline, theme });
					const selectedModel = modelRuntime.getModel(selection.providerId, selection.modelId);
					if (selectedModel) await agent.session.setModel(selectedModel, { persist: true });
					write(`${theme.success("✓ OAuth settings updated")}\n`);
				} catch (error) {
					write(`${theme.error(error instanceof Error ? error.message : String(error))}\n`);
				}
				continue;
			}
			if (command === "/new") {
				write(`${theme.dim("This tutor session is in memory. Restart learn-agent to begin a fresh conversation.")}\n`);
				continue;
			}

			write(renderUserLabel(theme, message));
			pendingProviderError = undefined;
			try {
				await agent.session.prompt(message);
			} catch (error) {
				if (workNotesOpen) {
					write("\n");
					workNotesOpen = false;
				}
				if (assistantOpen) {
					write("\n");
					assistantOpen = false;
				}
				write(`${formatProviderError(error, theme)}\n`);
			}
		}
	} finally {
		unsubscribe();
		if (ownsReadline) readline.close();
	}
}

function formatHelp(theme: TerminalTheme): string {
	return `\n${renderPanel(theme, "Commands", [
		{ label: "/learn", value: "toggle exploration in this session", tone: "accent" },
		{ label: "/question", value: "practice: [easy|medium|hard] [topic]; off to cancel", tone: "accent" },
		{ label: "/help", value: "show this guide", tone: "accent" },
		{ label: "Ctrl+Shift+D", value: "start or stop Voz dictation", tone: "accent" },
		{ label: "/theme", value: "list themes; use /theme <name> to switch", tone: "accent" },
		{ label: "/model", value: "show or switch the active provider/model", tone: "accent" },
		{ label: "/settings", value: "change provider or replace the API key", tone: "accent" },
		{ label: "/login", value: "start an SDK-provided OAuth/connector sign-in", tone: "accent" },
		{ label: "/new", value: "explain how to start a fresh tutor session", tone: "accent" },
		{ label: "/quit", value: "leave Pi Student", tone: "accent" },
	])}\n${theme.dim("Anything else is sent to Pi as your learning prompt.")}\n`;
}

function normalizeThemeName(value: string | undefined): string | undefined {
	if (!value) return undefined;
	return resolveThemeAlias(value);
}

function planProgressText(workflow: WorkflowController): string {
	const complete = workflow.state.plan.steps.filter((step) => step.status === "complete").length;
	return `${complete}/${workflow.state.plan.steps.length} student-authored steps`;
}

async function handleModelCommand(modelRef: string | undefined, agent: LearningAgentSession, runtime: ModelRuntime, theme: TerminalTheme, write: (text: string) => void): Promise<void> {
	if (modelRef) {
		const separator = modelRef.indexOf("/");
		if (separator < 1) {
			write(`${theme.error("Use /model provider/model-id")}\n`);
			return;
		}
		const provider = modelRef.slice(0, separator);
		const modelId = modelRef.slice(separator + 1);
		const model = runtime.getModel(provider, modelId);
		if (!model) {
			write(`${theme.error(`Unknown model: ${modelRef}`)}\n`);
			return;
		}
		try {
			await agent.session.setModel(model, { persist: true });
			write(`${theme.success("✓ Active model")} ${model.provider}/${model.id}\n`);
		} catch (error) {
			write(`${theme.error(error instanceof Error ? error.message : String(error))}\n`);
		}
		return;
	}

	const providers = runtime.getProviders().filter((provider) => runtime.getProviderAuthStatus(provider.id).configured);
	write(`\n${theme.bold("Configured models")}\n`);
	for (const provider of providers) {
		const model = await pickModel(runtime, provider.id);
		if (model) write(`  ${provider.id}/${model.id}\n`);
	}
	write(`${theme.dim("Switch with /model provider/model-id, or use /settings to connect another provider.")}\n`);
}

export function createReplUI(
	base: ExtensionUIContext,
	lines: AsyncIterator<string>,
	write: (text: string) => unknown,
): ExtensionUIContext {
	const input = async (title: string): Promise<string | undefined> => {
		write(`\n${title}\n› `);
		const next = await lines.next();
		if (next.done || next.value.trim() === "/cancel") return undefined;
		return next.value;
	};
	return {
		...base,
		input,
		editor: input,
		notify: message => { write(`${message}\n`); },
		confirm: async (title, message) => /^(y|yes)$/i.test((await input(`${title}\n${message}\nConfirm [y/N]`))?.trim() ?? ""),
		select: async (title, options) => {
			while (true) {
				const answer = await input(`${title}\n${options.map((option, i) => `${i + 1}. ${option}`).join("\n")}\nChoose a number, or /cancel`);
				if (answer === undefined) return undefined;
				const index = Number(answer.trim()) - 1;
				if (Number.isInteger(index) && options[index] !== undefined) return options[index];
				if (options.includes(answer)) return answer;
				write("Please choose a listed option.\n");
			}
		},
	};
}
