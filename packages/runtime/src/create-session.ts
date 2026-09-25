import { createApprovedExtensions } from "./approved-extensions.js";
import { authorizeExtension } from "./extension-authorization.js";
import { mcpCatalog, skillCatalog } from "@pi-student/shared/extension-catalog";
import { registerLearnMode } from "@pi-student/education/extension";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSession,
	createAgentSessionRuntime,
	createAgentSessionServices,
	DefaultResourceLoader,
	getAgentDir,
	isToolCallEventType,
	ModelRuntime,
	SessionManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createSandboxGrepTool, createSandboxToolDefinitions, readSandboxMode } from "@pi-student/sandbox/sandbox-manager";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import { WorkflowController } from "@pi-student/education/workflow-controller";
import { StudentQuestionLoop } from "@pi-student/education/student-question-loop";
import { displayLearningStage } from "@pi-student/education/stage";
import { inspectProjectContext, projectContextFacts, type ProjectContext } from "@pi-student/education/project-context";
import { routeIntent, type IntentRoute } from "@pi-student/education/intent";
import { createStudentAskExtension } from "./student-ask.js";
import { createLearningStateExtension } from "./learning-state.js";
import { createStudentPlanExtension } from "./student-plan.js";
import { createSaveToDesktopExtension } from "./save-to-desktop.js";
import { EDUCATIONAL_SYSTEM_PROMPT, stageGuidance } from "./prompts.js";
import { createModelRuntime, findFallbackModel, normalizeFallbackThinkingLevel } from "./model-runtime.js";
import { assertExecutionModel, refreshSessionModelInventory, selectExecutionModel, selectFallbackModel } from "./model-selection.js";
import { classifyTerminalCommand, isSafeInspectionCommand, isSafeVerificationCommand, isWorkspacePath } from "./command-policy.js";
import { formatProviderErrorMessage } from "./ui.js";
import { createBundledThemes, DEFAULT_THEME } from "./themes.js";
import { createTeacherTelemetryExtension, type StudentRuntimeServices } from "./telemetry-integration.js";
import { appendTranscript, DictationCancelledError, DictationController } from "./dictation.js";
import { runDictationSetup } from "./dictation-setup.js";
import {
	cueText,
	LEARNING_CUE_INTERVAL_MS,
	LEARNING_CUE_SCROLL_INTERVAL_MS,
	LEARNING_CUES,
	toolLearningCue,
	WORKING_FRAMES,
	type LearningCue,
} from "./progress.js";

import { createLearningSession, type LearningSession } from "@pi-student/education/types";
import { capabilityState, guardCapabilitySession } from "@pi-student/policy/capability-runtime";
import { createProjectCapabilitiesExtension } from "./project-capabilities.js";
import { createWorkspaceActivity, type WorkspaceActivityEmitter } from "./workspace-activity.js";
import { formatAssistanceFallback } from "./assistance.js";
import { resolveStudentCapabilities } from "./student-workspace.js";
import { modelAllowed, allowedReasoningLevels } from "@pi-student/policy/capability-policy";

const SANDBOX_SYSTEM_PROMPT = `
Project files and shell commands are sandboxed. The active student project is mounted at /workspace. Use /workspace for every read, write, search, and shell command; never use the host project path, process.cwd(), or any /Users/... path. If repository context is needed, inspect /workspace directly. Never ask for or expose the host project path. Provider authentication stays on the host and is not available to project processes.
`;

export interface LearningAgentSession {
	session: AgentSession;
	setActiveTools(): void;
	dispose(): void;
}

export interface LearningAgentRuntime {
	runtime: AgentSessionRuntime;
	dispose(): Promise<void>;
}

export interface LearningAgentRuntimeOptions {
	sessionManager?: SessionManager;
	thinkingLevel?: Parameters<AgentSession["setThinkingLevel"]>[0];
	services?: StudentRuntimeServices;
}

/**
 * Persist sessions against the real project directory. `/workspace` only
 * exists inside the sandbox, while Pi validates persisted session cwd values
 * on the host before creating or replacing an interactive runtime.
 */
export function createInteractiveSessionManager(projectCwd: string, sessionDir?: string): SessionManager {
	return SessionManager.create(projectCwd, sessionDir);
}

/**
 * Create the full Pi runtime used by the interactive terminal UI.
 *
 * InteractiveMode needs the runtime (rather than only an AgentSession) so it
 * can power Pi's transcript, editor, model picker, session commands, tool
 * cards, retry indicators, and provider-error rendering.
 */
export async function createLearningAgentRuntime(
	cwd: string,
	workflow: WorkflowController,
	modelRuntime: ModelRuntime,
	model: ReturnType<ModelRuntime["getModel"]>,
	sandbox?: SandboxRuntime,
	options: LearningAgentRuntimeOptions = {},
): Promise<LearningAgentRuntime> {
	const sandboxRuntime = requireSandboxRuntime(sandbox);
	if (options.services?.executionContext) await refreshSessionModelInventory(modelRuntime, await options.services.executionContext());
	if (!sandboxRuntime.isRunning()) await sandboxRuntime.start(cwd);
	const agentDir = getAgentDir();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
		await options.services?.bindSession?.(sessionManager);
		const executionContext = await options.services?.executionContext?.();
		const savedModel = sessionManager.buildSessionContext().model;
		const sessionModel = executionContext
			? (await selectExecutionModel(modelRuntime, executionContext,
				savedModel ? undefined : model ? `${model.provider}/${model.id}` : undefined, sessionManager)).model
			: model;
		workflow = restoreWorkflow(sessionManager, runtimeCwd);
		if (!sandboxRuntime.isRunning()) await sandboxRuntime.start(runtimeCwd);
		const sandboxCwd = sandboxRuntime.getWorkspacePath();
		const activityWorkflow = workflow;
		const activity = createWorkspaceActivity(workflow, sandboxRuntime, {
			contextStore: options.services?.contextStore,
			capabilities: async observed => {
				const context = await options.services?.executionContext?.();
				return context && resolveStudentCapabilities(context, { ...observed, usage: capabilityState(activityWorkflow),
					stage: activityWorkflow.getStage(), sandbox: { running: sandboxRuntime.isRunning() } });
			},
		});
		const services = await createAgentSessionServices({
			cwd: sandboxCwd,
			agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				noSkills: true,
				extensionFactories: [
					createSandboxExtension(sandboxRuntime),
					createLearningExtension(workflow, modelRuntime, sandboxRuntime, options.services, activity.emit),
					createTeacherTelemetryExtension(workflow, sandboxRuntime, options.services, activity.emit,
						async reason => formatAssistanceFallback(await activity.actions({ exhausted: reason }) ?? [], reason)),
					createApprovedExtensions(options.services, () => workflow.getStage()),
					activity.extension,
				],
				extensionsOverride: removeLlamaCommand,
				themesOverride: addBundledThemes,
			},
		});
		services.settingsManager.applyOverrides({
			editorPaddingX: 1,
			outputPad: 1,
			// Keep reasoning available in the transcript without opening the
			// disclosure by default. Students can expand it when they want detail.
			hideThinkingBlock: true,
			// Skills are not part of the student workflow.
			enableSkillCommands: false,
			// Keep Pi's resource inventory out of the student-facing header. The
			// resources remain loaded and available to the session.
			quietStartup: true,
			...(services.settingsManager.getThemeSetting() ? {} : { theme: DEFAULT_THEME }),
		});
		const sessionResult = await createAgentSession({
			cwd: sandboxCwd,
			agentDir,
			modelRuntime,
			settingsManager: services.settingsManager,
			resourceLoader: services.resourceLoader,
			sessionManager,
			sessionStartEvent,
			model: sessionModel,
			thinkingLevel: options.thinkingLevel,
			// The SDK treats `tools` as a permanent session allowlist. Register the
			// union of every stage's tools, then narrow the active set below. Passing
			// only the startup stage here would make later-stage tools impossible to
			// activate for the lifetime of the session.
			tools: [...workflow.getRegisteredTools()],
		});
		await refreshApprovedExtensionTools(sessionResult.session, workflow, options.services);
		guardCapabilitySession(sessionResult.session, capabilityState(workflow), async selected => {
			const context = await options.services?.executionContext?.();
			if (!context) return;
			await options.services?.reconcileEnvironment?.(context);
			await refreshApprovedExtensionTools(sessionResult.session, workflow, options.services, context);
			capabilityState(workflow).effective = context.policy;
			await refreshSessionModelInventory(modelRuntime, context);
			if (!selected) throw new Error("Select an available model before continuing.");
			await assertExecutionModel(modelRuntime, context, selected);
		}, async reason => formatAssistanceFallback(await activity.actions() ?? [], reason));
		const sessionWorkflow = workflow;
		sessionWorkflow.onChange(() => {
			sessionManager.appendCustomEntry("pi-student-workflow", structuredClone(sessionWorkflow.state));
			void refreshApprovedExtensionTools(sessionResult.session, sessionWorkflow, options.services).catch(() => {
				sessionResult.session.setActiveToolsByName([...sessionWorkflow.getAllowedTools()]);
			});
		});
		return {
			...sessionResult,
			// AgentSessionRuntime uses services.cwd to create and validate
			// persisted sessions. The AgentSession and its extensions keep the
			// sandbox cwd above, so the host project path is not model-visible.
			services: { ...services, cwd: runtimeCwd },
			diagnostics: services.diagnostics,
		};
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: options.sessionManager ?? createInteractiveSessionManager(cwd),
	});

	return {
		runtime,
		async dispose() {
			await runtime.dispose();
		},
	};
}

function createLearningExtension(workflow: WorkflowController, modelRuntime: ModelRuntime, sandbox: SandboxRuntime, services?: StudentRuntimeServices,
	emitActivity?: WorkspaceActivityEmitter): ExtensionFactory {
	const questionLoop = new StudentQuestionLoop();
	return (pi) => {
		const exploration = registerLearnMode(pi, workflow, sandbox, undefined, {
			onQuestionCompleted: question => emitActivity?.("question", { type: "question.completed", difficulty: question.difficulty, topic: question.topic }),
		});
		let fallbackAttempted = false;
		let activeRoute: IntentRoute | undefined;
		let activeProjectContext: ProjectContext | undefined;
		let progressTimer: ReturnType<typeof setInterval> | undefined;
		let progressIndex = 0;
		const progressKey = "pi-student-progress";
		const cueKey = "pi-student-learning-cue";
		const stopProgressTimer = () => {
			if (progressTimer) clearInterval(progressTimer);
			progressTimer = undefined;
		};
		const showProgress = (ctx: ExtensionContext, cue: LearningCue) => {
			if (ctx.mode !== "tui") return;
			ctx.ui.setWorkingMessage(`${cueText(cue)} · Esc to stop`);
			ctx.ui.setStatus(progressKey, `learning · ${cue.label} · Esc to stop`);
			ctx.ui.setWidget(cueKey, (tui, theme) => createLearningCueWidget(tui, theme, cue), { placement: "aboveEditor" });
		};
		const startProgress = (ctx: ExtensionContext) => {
			if (ctx.mode !== "tui") return;
			stopProgressTimer();
			progressIndex = 0;
			ctx.ui.setWorkingIndicator({ frames: [...WORKING_FRAMES], intervalMs: 90 });
			showProgress(ctx, LEARNING_CUES[progressIndex]);
			progressTimer = setInterval(() => {
				progressIndex = (progressIndex + 1) % LEARNING_CUES.length;
				showProgress(ctx, LEARNING_CUES[progressIndex]);
			}, LEARNING_CUE_INTERVAL_MS);
		};
		const finishProgress = (ctx: ExtensionContext) => {
			stopProgressTimer();
			if (ctx.mode !== "tui") return;
			ctx.ui.setStatus(progressKey, "ready · review the response and ask a follow-up");
			ctx.ui.setWorkingMessage();
		};
		pi.on("input", async (event, ctx) => {
			if (event.text === "/skill" || event.text.startsWith("/skill:") || event.text === "/llama" || event.text.startsWith("/llama ")) {
				ctx.ui.notify("That command is disabled in Pi Student.", "warning");
				return { action: "handled" };
			}
			return { action: "continue" };
		});
		const prepareRoutingContext = async (studentMessage: string) => {
			activeProjectContext = await inspectProjectContext(sandbox);
			activeRoute = routeIntent(studentMessage, {
				projectContext: activeProjectContext,
				currentIntent: workflow.getIntent(),
			});
			workflow.setRoutingContext(activeRoute, activeProjectContext);
			return {
				intent: activeRoute.intent,
				intentAmbiguous: activeRoute.ambiguous,
				projectContext: activeProjectContext,
				knownFacts: projectContextFacts(activeProjectContext),
			};
		};
		createStudentAskExtension(
			questionLoop,
			() => ({ stage: workflow.getStage(), intent: activeRoute?.intent, projectContext: activeProjectContext }),
			prepareRoutingContext,
			() => workflow.isExploring(),
		)(pi);
		createLearningStateExtension(workflow)(pi);
		createStudentPlanExtension(workflow)(pi);
		createSaveToDesktopExtension(workflow, sandbox)(pi);
		createStudentDictationExtension(capabilityState(workflow))(pi);
		createProjectCapabilitiesExtension(capabilityState(workflow), sandbox)(pi);
		let stopStageStatus: (() => void) | undefined;
		pi.on("session_start", async (_event, ctx) => {
			if (!sandbox.isRunning()) await sandbox.start(workflow.state.cwd);
			fallbackAttempted = false;
			// One indicator for every UI (TUI footer, Paseo RPC status), driven only by the controller's stage.
			stopStageStatus?.();
			const stageStatusKey = "pi-student-stage";
			ctx.ui.setStatus(stageStatusKey, `stage · ${displayLearningStage(workflow.getStage())}`);
			stopStageStatus = workflow.onStageChange(stage => ctx.ui.setStatus(stageStatusKey, `stage · ${displayLearningStage(stage)}`));
			ctx.ui.setWorkingMessage("Understanding the request · Esc to stop");
			ctx.ui.setHiddenThinkingLabel("Work notes hidden · select this line to review them");
			if (ctx.mode === "tui") {
				ctx.ui.setWorkingIndicator({ frames: [...WORKING_FRAMES], intervalMs: 90 });
				ctx.ui.setStatus(progressKey, "ready · ask a question to begin");
				ctx.ui.setWidget(cueKey, (tui, theme) => createLearningCueWidget(tui, theme, LEARNING_CUES[0]), { placement: "aboveEditor" });
			}
			if (ctx.mode === "tui") {
				ctx.ui.setHeader((_tui, activeTheme) => ({
					render: (width) => renderStudentHeader(activeTheme, width, workflow, ctx.model, readSandboxMode()),
					invalidate() {},
				}));
			}
		});
		pi.on("agent_start", async (_event, ctx) => {
			fallbackAttempted = false;
			startProgress(ctx);
		});
		pi.on("turn_start", async (_event, ctx) => {
			showProgress(ctx, LEARNING_CUES[2]);
		});
		pi.on("message_update", async (event, ctx) => {
			if (event.message.role !== "assistant") return;
			if (event.assistantMessageEvent.type === "thinking_start") showProgress(ctx, LEARNING_CUES[2]);
			if (event.assistantMessageEvent.type === "text_start") showProgress(ctx, LEARNING_CUES[5]);
		});
		pi.on("tool_execution_start", async (event, ctx) => {
			showProgress(ctx, toolLearningCue(event.toolName));
		});
		pi.on("tool_execution_end", async (event, ctx) => {
			showProgress(ctx, event.isError ? {
				label: "Reviewing a failed step",
				detail: "pausing to understand the error before trying again",
				fact: "A useful error message is evidence: it narrows the set of possible causes.",
			} : LEARNING_CUES[4]);
		});
		pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "assistant" || event.message.stopReason !== "error" || !event.message.errorMessage) return;
			const rawError = event.message.errorMessage;
			const current = ctx.model;
			const shouldFallback = !fallbackAttempted && current && /429|quota|rate limit|resource exhausted|\b(502|503|504)\b|temporarily unavailable|overloaded/i.test(rawError);
			if (shouldFallback) {
				const controls = capabilityState(workflow);
				const context = await services?.executionContext?.();
				const preferred = services?.preferredFallbackModelId?.(current.provider, current.id);
				const fallback = context
					? (await selectFallbackModel(modelRuntime, context, current, preferred))?.model
					: findFallbackModel(modelRuntime, current, model =>
						!(controls.effective?.sourceVersions?.organization && !controls.settings.models.length) && modelAllowed(controls.settings, model));
				if (fallback) {
					fallbackAttempted = true;
					const requestedLevel = pi.getThinkingLevel();
					const switched = await pi.setModel(fallback);
					if (switched) {
						const permitted = allowedReasoningLevels(capabilityState(workflow).settings, fallback);
						const normalized = normalizeFallbackThinkingLevel(fallback, requestedLevel);
						pi.setThinkingLevel(permitted.includes(normalized) ? normalized : permitted[0]!);
						ctx.ui.setStatus("pi-model-fallback", `Fallback: ${current.provider}/${current.id} → ${fallback.provider}/${fallback.id}`);
						ctx.ui.notify(`Provider unavailable. Switched to ${fallback.provider}/${fallback.id}.`, "warning");
						event.message.errorMessage = `${formatProviderErrorMessage(rawError)} Switching to ${fallback.name || fallback.id} and retrying.`;
						return;
					}
				}
				if (preferred) ctx.ui.notify(`Configured fallback ${preferred} is unavailable. Select another approved model.`, "warning");
			}
			event.message.errorMessage = formatProviderErrorMessage(rawError);
		});
		pi.on("agent_settled", async (_event, ctx) => finishProgress(ctx));
		pi.on("before_agent_start", async (event, ctx) => {
			showProgress(ctx, LEARNING_CUES[1]);
			const guidance = exploration.guidance();
			if (guidance) return { systemPrompt: `${event.systemPrompt}\n${SANDBOX_SYSTEM_PROMPT}\n${guidance}` };
			return {
					systemPrompt: `${event.systemPrompt}\n\n${SANDBOX_SYSTEM_PROMPT}\n${capabilityState(workflow).settings.reflection ? EDUCATIONAL_SYSTEM_PROMPT : EDUCATIONAL_SYSTEM_PROMPT.replace("Require a review of changes before verification and reflection before completion.", "Require a review of changes before verification. Reflection is disabled for this project; do not request it.")}\n${stageGuidance(workflow.getStage(), workflow.getIntent())}`,
			};
		});
		pi.on("session_shutdown", async () => {
			stopProgressTimer();
			stopStageStatus?.();
			stopStageStatus = undefined;
			await sandbox.stop();
		});
		pi.on("tool_call", async (event) => {
			// These tools only read approved guidance or curated public documentation;
			// their handlers recheck school policy and project scope on every call.
			if (event.toolName === "school_skill" || event.toolName === "school_mcp" || workflow.canUseTool(event.toolName)) return undefined;
			return {
				block: true,
				reason: `Tool ${event.toolName} is not available during ${workflow.getStage()}.`,
			};
		});
		registerStudentRuntimeGuards(pi, workflow);
	};
}

const LEARNING_CUE_VIEWPORT_LINES = 3;

/**
 * Keep long facts readable inside the small widget area above the editor.
 * The widget deliberately exposes only a few wrapped lines and advances
 * slowly, with pauses at both ends, instead of clipping the fact horizontally.
 */
function createLearningCueWidget(tui: TUI, theme: Theme, cue: LearningCue): Component & { dispose(): void } {
	let wrappedLines: string[] = [];
	let wrappedWidth = 0;
	let scrollOffset = 0;
	let holdTicks = 2;

	const getLines = (width: number): string[] => {
		const contentWidth = Math.max(1, width - 2);
		if (wrappedWidth !== contentWidth) {
			wrappedWidth = contentWidth;
			wrappedLines = wrapTextWithAnsi(
				`${theme.fg("accent", "Did you know?")} ${theme.fg("dim", cue.fact)}`,
				contentWidth,
			);
			scrollOffset = 0;
			holdTicks = 2;
		}
		return wrappedLines;
	};

	const timer = setInterval(() => {
		const maxOffset = Math.max(0, wrappedLines.length - LEARNING_CUE_VIEWPORT_LINES);
		if (maxOffset === 0) return;
		if (holdTicks > 0) {
			holdTicks -= 1;
			return;
		}
		scrollOffset = scrollOffset < maxOffset ? scrollOffset + 1 : 0;
		holdTicks = 2;
		tui.requestRender();
	}, LEARNING_CUE_SCROLL_INTERVAL_MS);

	return {
		render(width) {
			const lines = getLines(width);
			const maxOffset = Math.max(0, lines.length - LEARNING_CUE_VIEWPORT_LINES);
			const offset = Math.min(scrollOffset, maxOffset);
			return lines.slice(offset, offset + LEARNING_CUE_VIEWPORT_LINES).map(line => ` ${line}`);
		},
		invalidate() {
			wrappedWidth = 0;
		},
		dispose() {
			clearInterval(timer);
		},
	};
}

function createStudentDictationExtension(controls: ReturnType<typeof capabilityState>): ExtensionFactory {
	return (pi) => {
		const dictation = new DictationController();
		let consentGranted = false;
		let unsubscribeTerminalInput: (() => void) | undefined;
		const setup = (ctx: ExtensionContext) => runDictationSetup(dictation, {
			select: (title, options) => ctx.ui.select(title, options),
			// Pi's fullscreen input dialog keeps the key out of the conversation and
			// the project; the credential store writes it outside the workspace.
			secret: (title, placeholder) => ctx.ui.input(title, placeholder),
			notify: (message, type) => ctx.ui.notify(message, type),
		});

		const toggle = async (ctx: ExtensionContext) => {
			try {
				if (!controls.settings.accessibility.dictation) {
					await dictation.cancel(); controls.block("dictation");
					ctx.ui.notify("Dictation is disabled for this project.", "info"); return;
				}
				if (dictation.isRecording()) {
					ctx.ui.setStatus("pi-student-dictation", "student · transcribing…");
					ctx.ui.notify("Transcribing your recording…", "info");
					const transcript = await dictation.stop({ allowRemote: controls.settings.accessibility.cloudDictation });
					ctx.ui.setEditorText(appendTranscript(ctx.ui.getEditorText(), transcript));
					ctx.ui.setStatus("pi-student-dictation", undefined);
					ctx.ui.notify("Dictation added to your prompt. Review it, then press Enter.", "info");
					return;
				}

				const backend = await dictation.getBackend() ?? await setup(ctx);
				if (!backend) return;
				const started = await dictation.start({
					allowRemote: controls.settings.accessibility.cloudDictation,
					confirmRemote: async () => {
						if (consentGranted) return true;
						const confirmed = await ctx.ui.confirm(
							"Allow voice transcription?",
							`${backend.label} will receive this short audio recording to create text. The audio is not saved by Pi Student.`,
						);
						if (confirmed) consentGranted = true;
						return confirmed;
					},
				});
				ctx.ui.setStatus("pi-student-dictation", "student · listening · press Ctrl+Shift+D to stop");
				ctx.ui.notify(`Listening with ${started.label}. Press Ctrl+Shift+D again when you finish speaking.`, "info");
			} catch (error) {
				if (error instanceof DictationCancelledError) return;
				ctx.ui.setStatus("pi-student-dictation", undefined);
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		};

		pi.registerShortcut("ctrl+shift+d", {
			description: "Start or stop voice dictation",
			handler: toggle,
		});
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
				if (!matchesKey(data, "ctrl+shift+d") && !matchesKey(data, "shift+ctrl+d")) return undefined;
				void toggle(ctx);
				return { consume: true };
			});
		});
		pi.on("session_shutdown", async () => {
			unsubscribeTerminalInput?.();
			unsubscribeTerminalInput = undefined;
			await dictation.cancel();
		});
	};
}

function removeLlamaCommand<T extends { extensions: Array<{ commands: Map<string, unknown> }> }>(base: T): T {
	return {
		...base,
		extensions: base.extensions.map((extension) => {
			if (!extension.commands.has("llama")) return extension;
			const commands = new Map(extension.commands);
			commands.delete("llama");
			return { ...extension, commands };
		}),
	};
}

function addBundledThemes(base: ReturnType<import("@earendil-works/pi-coding-agent").ResourceLoader["getThemes"]>) {
	return { themes: [...base.themes, ...createBundledThemes()], diagnostics: base.diagnostics };
}

function renderStudentHeader(
	theme: Theme,
	width: number,
	workflow: WorkflowController,
	model: { provider: string; id: string } | undefined,
	sandboxMode: "host" | "gondolin",
): string[] {
	if (width < 34) {
		return [
			`${theme.fg("accent", theme.bold("Pi Student"))} ${theme.fg("dim", `· ${workflow.getStage().toUpperCase()}`)}`,
			`${theme.fg(sandboxMode === "host" ? "warning" : "success", sandboxMode === "host" ? "host mode" : "sandboxed")}`,
			"",
		];
	}
	const frameWidth = width;
	const innerWidth = frameWidth - 2;
	const border = (text: string) => theme.fg("border", text);
	const title = "Pi Student";
	const topLabel = `─ ${title} `;
	const top = `${border("╭")}${theme.fg("borderAccent", topLabel)}${border("─".repeat(Math.max(0, innerWidth - topLabel.length)))}${border("╮")}`;
	const bottom = `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`;
	const row = (label: string, value: string, color: "text" | "success" | "warning" | "accent" = "text") => {
		const plain = `  ${label.padEnd(9)} ${value}`;
		const clipped = clipText(plain, Math.max(1, innerWidth - 2));
		const padding = " ".repeat(Math.max(0, innerWidth - clipped.length - 1));
		return `${border("│")} ${theme.fg("dim", clipped.slice(0, Math.min(11, clipped.length)))}${theme.fg(color, clipped.slice(Math.min(11, clipped.length)))}${padding}${border("│")}`;
	};
	const sandboxValue = sandboxMode === "host" ? "host mode · commands run outside the sandbox" : "active · commands are sandboxed";
	return [
		top,
		row("workspace", workflow.state.cwd),
		row("model", model ? `${model.provider}/${model.id}` : "none"),
		row("sandbox", sandboxValue, sandboxMode === "host" ? "warning" : "success"),
		bottom,
		"",
	];
}

function clipText(value: string, width: number): string {
	const characters = Array.from(value);
	if (characters.length <= width) return value;
	if (width <= 1) return "…";
	return `${characters.slice(0, width - 1).join("")}…`;
}

function createSandboxExtension(sandbox: SandboxRuntime): ExtensionFactory {
	return (pi) => {
		for (const tool of [...createSandboxToolDefinitions(sandbox), createSandboxGrepTool(sandbox)]) {
			pi.registerTool(tool);
		}
	};
}

async function refreshApprovedExtensionTools(
	session: AgentSession,
	workflow: WorkflowController,
	services: StudentRuntimeServices | undefined,
	knownContext?: import("@pi-student/contracts").ExecutionContext,
): Promise<void> {
	const tools = [...workflow.getAllowedTools()];
	// Drop previously exposed school tools synchronously on a workflow/control
	// change. The fresh snapshot below can only add them back after authorization.
	session.setActiveToolsByName([...new Set(tools)]);
	const context = knownContext ?? await services?.executionContext?.();
	if (context) {
		const stage = workflow.getStage();
		if (context.skills?.some(item => item.artifactDigest === skillCatalog[0]?.artifactDigest && authorizeExtension(context, item, "skill", "list", stage).allowed)) tools.push("school_skill");
		if (context.mcps?.some(item => authorizeExtension(context, item, "mcp", "list", stage, mcpCatalog.find(entry => entry.endpoint === item.endpoint)).allowed)) tools.push("school_mcp");
	}
	session.setActiveToolsByName([...new Set(tools)]);
}

export async function createLearningAgentSession(
	cwd: string,
	workflow: WorkflowController,
	modelRuntime?: ModelRuntime,
	model?: NonNullable<ReturnType<ModelRuntime["getModel"]>>,
	sandbox?: SandboxRuntime,
	options: Pick<LearningAgentRuntimeOptions, "services"> = {},
): Promise<LearningAgentSession> {
	const runtime = modelRuntime ?? (await createModelRuntime());
	if (options.services?.executionContext) await refreshSessionModelInventory(runtime, await options.services.executionContext());
	const sandboxRuntime = requireSandboxRuntime(sandbox);
	if (!sandboxRuntime.isRunning()) await sandboxRuntime.start(cwd);
	const sessionManager = SessionManager.inMemory(cwd);
	await options.services?.bindSession?.(sessionManager);
	const executionContext = await options.services?.executionContext?.();
	const sessionModel = executionContext
		? (await selectExecutionModel(runtime, executionContext, model ? `${model.provider}/${model.id}` : undefined, sessionManager)).model
		: model;
	const resourceLoader = new DefaultResourceLoader({
		cwd: sandboxRuntime.getWorkspacePath(),
		agentDir: getAgentDir(),
		noSkills: true,
		extensionFactories: [
			createSandboxExtension(sandboxRuntime),
			createLearningExtension(workflow, runtime, sandboxRuntime, options.services),
			createTeacherTelemetryExtension(workflow, sandboxRuntime, options.services),
			createApprovedExtensions(options.services, () => workflow.getStage()),
		],
		themesOverride: addBundledThemes,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd: sandboxRuntime.getWorkspacePath(),
		modelRuntime: runtime,
		model: sessionModel,
		resourceLoader,
		tools: [...workflow.getRegisteredTools()],
		sessionManager,
	});
	await refreshApprovedExtensionTools(session, workflow, options.services);
	guardCapabilitySession(session, capabilityState(workflow), async selected => {
		const context = await options.services?.executionContext?.();
		if (!context) return;
		await options.services?.reconcileEnvironment?.(context);
		await refreshApprovedExtensionTools(session, workflow, options.services, context);
		capabilityState(workflow).effective = context.policy;
		await refreshSessionModelInventory(runtime, context);
		if (!selected) throw new Error("Select an available model before continuing.");
		await assertExecutionModel(runtime, context, selected);
	});
	const unsubscribeFromStages = workflow.onChange(() => {
		// Stage changes are committed by the workflow layer; sync Pi's active
		// tools immediately before the next prompt is accepted.
		void refreshApprovedExtensionTools(session, workflow, options.services).catch(() => {
			session.setActiveToolsByName([...workflow.getAllowedTools()]);
		});
	});

	return {
		session,
		setActiveTools() {
			// Called between turns after the controller commits a stage transition.
			void refreshApprovedExtensionTools(session, workflow, options.services).catch(() => {
				session.setActiveToolsByName([...workflow.getAllowedTools()]);
			});
		},
		dispose() {
			unsubscribeFromStages();
			session.dispose();
		},
	};
}

function requireSandboxRuntime(sandbox: SandboxRuntime | undefined): SandboxRuntime {
	if (!sandbox) throw new Error("A SandboxRuntime must be provided by the client application.");
	return sandbox;
}

function registerStudentRuntimeGuards(pi: ExtensionAPI, workflow: WorkflowController): void {
	pi.on("tool_call", async (event, ctx) => {
		const projectPath = isToolCallEventType("read", event) || isToolCallEventType("write", event) || isToolCallEventType("edit", event)
			? event.input.path
			: isToolCallEventType("ls", event) || isToolCallEventType("find", event) || isToolCallEventType("grep", event)
				? event.input.path
				: undefined;
		if (projectPath && !isWorkspacePath(projectPath, ctx.cwd)) {
			return {
				block: true,
				reason: `PATH_OUTSIDE_WORKSPACE: use ${ctx.cwd} (the sandbox workspace) instead of the requested host path.`,
			};
		}
		if (!isToolCallEventType("bash", event)) return undefined;
		const command = event.input.command;
		if (workflow.isExploring() && !isSafeInspectionCommand(command, ctx.cwd)) return { block: true, reason: "Learn and question practice allow only read-only inspection. Switch Learn off before implementation." };
		const classification = classifyTerminalCommand(command, ctx.cwd);

		if (classification === "student-checkpoint") {
			return {
				block: true,
				reason: "This is a student terminal checkpoint. Ask the student to perform it and report the result.",
			};
		}
		if (classification === "approval-required") {
			const confirmed = ctx.hasUI && await ctx.ui.confirm(
				"Confirm a potentially destructive command",
				`${command}\n\nThis action may delete, overwrite, change system state, or leave the project workspace. Continue?`,
			);
			if (!confirmed) {
				return { block: true, reason: "The student did not approve this potentially destructive command." };
			}
		}
		if (workflow.getStage() === "verify" && !isSafeVerificationCommand(command, ctx.cwd)) {
			return {
				block: true,
				reason: "VERIFY permits inspection plus project test, build, and lint commands. Use IMPLEMENT for other shell work.",
			};
		}
		if (workflow.getStage() !== "implement" && workflow.getStage() !== "verify" && !isSafeInspectionCommand(command, ctx.cwd)) {
			return {
				block: true,
				reason: `Only safe read-only inspection commands are available during ${workflow.getStage().toUpperCase()}.`,
			};
		}
		if (classification === "unknown" && workflow.getStage() !== "implement") {
			return { block: true, reason: "This command is not recognized as safe inspection during the current stage." };
		}
		return undefined;
	});
}

export function restoreWorkflow(sessionManager: Pick<SessionManager, "getBranch">, cwd: string): WorkflowController {
	const entry = [...sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "pi-student-workflow");
	const state = entry?.type === "custom" ? entry.data as LearningSession | undefined : undefined;
	return new WorkflowController(state && state.cwd === cwd ? structuredClone(state) : createLearningSession(cwd));
}
