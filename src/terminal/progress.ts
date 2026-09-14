export interface LearningCue {
	readonly label: string;
	readonly detail: string;
	readonly fact: string;
}

/** Short, student-facing milestones. These describe observable work, not private chain-of-thought. */
export const LEARNING_CUES: readonly LearningCue[] = [
	{
		label: "Understanding the request",
		detail: "finding the goal and the constraints",
		fact: "Grace Hopper helped develop one of the first compilers and popularized machine-independent programming languages.",
	},
	{
		label: "Checking project context",
		detail: "looking at the workspace before making assumptions",
		fact: "Ada Lovelace wrote an algorithm for Charles Babbage’s Analytical Engine in the 1840s.",
	},
	{
		label: "Choosing a next step",
		detail: "connecting the goal to a small, testable action",
		fact: "The word ‘debugging’ became famous after a moth was found in a computer relay in 1947.",
	},
	{
		label: "Inspecting the relevant files",
		detail: "gathering evidence before editing",
		fact: "Margaret Hamilton’s software team helped make Apollo’s lunar-landing computer resilient under overload.",
	},
	{
		label: "Running a check",
		detail: "looking for evidence that the change works",
		fact: "A good test is a small experiment: it makes one claim easier to verify.",
	},
	{
		label: "Preparing the explanation",
		detail: "turning the result into a lesson you can inspect",
		fact: "Katherine Johnson’s calculations helped verify orbital paths for early crewed spaceflight.",
	},
] as const;

export const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Keep each educational cue on screen long enough to read. */
export const LEARNING_CUE_INTERVAL_MS = 12_000;

/** Advance long cue text slowly so it can be read a line at a time. */
export const LEARNING_CUE_SCROLL_INTERVAL_MS = 1_800;

export function toolLearningCue(toolName: string): LearningCue {
	const normalized = toolName.toLowerCase();
	if (normalized.includes("read") || normalized.includes("grep") || normalized.includes("find") || normalized.includes("ls")) {
		return LEARNING_CUES[3];
	}
	if (normalized.includes("bash") || normalized.includes("shell") || normalized.includes("test")) {
		return LEARNING_CUES[4];
	}
	if (normalized.includes("write") || normalized.includes("edit")) {
		return {
			label: "Making the proposed change",
			detail: "applying the approved edit in the sandbox",
			fact: "Small edits are easier to review, test, and undo than a large rewrite.",
		};
	}
	return LEARNING_CUES[2];
}

export function cueText(cue: LearningCue): string {
	return `${cue.label} · ${cue.detail}`;
}

/** Keep carriage-return animations on one physical terminal row. */
export function fitTerminalLine(value: string, columns = 80): string {
	const width = Math.max(1, Math.floor(columns));
	const characters = Array.from(value);
	return characters.length <= width ? value : `${characters.slice(0, width - 1).join("")}…`;
}

export interface StartupCueLoader {
	start(): void;
	stop(message?: string): void;
}

/** A tiny pre-TUI loader for sandbox/model startup. It stays silent for piped output. */
export function createStartupCueLoader(output: NodeJS.WritableStream): StartupCueLoader {
	const isInteractive = Boolean((output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY);
	const columns = (output as NodeJS.WritableStream & { columns?: number }).columns ?? 80;
	const startupPhases = [
		"Starting Pi Student",
		"Preparing the sandbox",
		"Loading the model",
		"Opening the learning workspace",
	] as const;
	let timer: ReturnType<typeof setInterval> | undefined;
	let frameIndex = 0;
	let phaseIndex = 0;
	let started = false;

	const render = () => {
		const frame = WORKING_FRAMES[frameIndex % WORKING_FRAMES.length];
		const phase = startupPhases[phaseIndex % startupPhases.length];
		output.write(`\r\x1b[2K${fitTerminalLine(`${frame} ${phase}`, columns)}`);
		frameIndex += 1;
	};

	return {
		start() {
			if (!isInteractive || timer || started) return;
			started = true;
			frameIndex = 0;
			phaseIndex = 0;
			render();
			timer = setInterval(() => {
				if (frameIndex % WORKING_FRAMES.length === 0) phaseIndex += 1;
				render();
			}, 120);
		},
		stop(message = "Pi Student is ready") {
			if (!isInteractive || !started) return;
			if (timer) clearInterval(timer);
			timer = undefined;
			started = false;
			output.write(`\r\x1b[2K✓ ${message}\n`);
		},
	};
}

export interface TerminalWorkingProgress {
	start(): void;
	phase(cue: LearningCue): void;
	stop(message?: string): void;
}

/** Working feedback for the non-fullscreen terminal fallback. */
export function createTerminalWorkingProgress(output: NodeJS.WritableStream): TerminalWorkingProgress {
	const isInteractive = Boolean((output as NodeJS.WritableStream & { isTTY?: boolean }).isTTY);
	const columns = (output as NodeJS.WritableStream & { columns?: number }).columns ?? 80;
	let active = false;
	let frameIndex = 0;
	let cue: LearningCue = LEARNING_CUES[0];
	let timer: ReturnType<typeof setInterval> | undefined;

	const render = () => {
		const frame = WORKING_FRAMES[frameIndex % WORKING_FRAMES.length];
		output.write(`\r\x1b[2K${fitTerminalLine(`${frame} ${cueText(cue)} · Esc to stop`, columns)}`);
		frameIndex += 1;
	};

	return {
		start() {
			if (active) return;
			active = true;
			frameIndex = 0;
			if (!isInteractive) return;
			render();
			timer = setInterval(render, 120);
		},
		phase(nextCue) {
			cue = nextCue;
			if (active && isInteractive) render();
		},
		stop(message = "Response ready") {
			if (!active) return;
			active = false;
			if (timer) clearInterval(timer);
			timer = undefined;
			if (isInteractive) output.write(`\r\x1b[2K✓ ${message}\n`);
		},
	};
}
