import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { CapabilityState } from "@pi-student/policy/capability-runtime";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import { isSafeInspectionCommand } from "./command-policy.js";

const TUTORING_PROMPT = "Tutoring mode: the agent implementation budget for this session is used up. You have no tools. Help the student do the work themselves: explain concepts and errors, ask guiding questions, suggest the next small step, and point to the files or lines to look at. Do not write complete solutions for the student to paste.";

export function createProjectCapabilitiesExtension(state: CapabilityState, sandbox: SandboxRuntime): ExtensionFactory {
	return pi => {
		let answer = "";
		let toolsBeforeTutoring: string[] | undefined;
		let speech: ChildProcess | undefined;
		const stopSpeech = () => { speech?.kill(); speech = undefined; };
		pi.registerCommand("read-aloud", {
			description: "Read the latest answer aloud, or stop reading",
			handler: async (_args, ctx) => {
				if (speech) { stopSpeech(); return; }
				if (!state.settings.accessibility.readAloud) { ctx.ui.notify("Read aloud is not enabled for this project.", "info"); return; }
				if (!answer) { ctx.ui.notify("There is no answer to read yet.", "info"); return; }
				const child = spawn(process.platform === "darwin" ? "say" : "espeak", process.platform === "darwin" ? [] : ["--stdin"], { stdio: ["pipe", "ignore", "ignore"] });
				speech = child;
				child.on("error", () => { if (speech === child) speech = undefined; ctx.ui.notify("No system voice is available. Read aloud requires macOS speech or espeak on Linux.", "info"); });
				child.on("close", () => { if (speech === child) speech = undefined; });
				child.stdin?.on("error", () => {});
				child.stdin?.end(answer);
			},
		});
		pi.on("session_shutdown", async () => stopSpeech());
		pi.on("before_agent_start", async event => {
			stopSpeech(); answer = "";
			const p = state.settings;
			sandbox.setInternetAllowed?.(p.internet);
			// Tutoring mode sends no tools, so the request is tool-free end to end
			// (the institution gateway admits only tool-free requests from a reserve).
			const tutoring = state.tutoringOnly();
			// Workflow refreshes may re-activate tools between turns, so clear them on every tutoring turn.
			const active = tutoring ? pi.getActiveTools() : [];
			if (active.length) { toolsBeforeTutoring = active; pi.setActiveTools([]); }
			else if (!tutoring && toolsBeforeTutoring) { if (!pi.getActiveTools().length) pi.setActiveTools(toolsBeforeTutoring); toolsBeforeTutoring = undefined; }
			if (!state.effective && !tutoring) return;
			const tutor = tutoring ? `\n\n${TUTORING_PROMPT}` : "";
			if (!state.effective) return { systemPrompt: `${event.systemPrompt}${tutor}` };
			return { systemPrompt: `${event.systemPrompt}\n\nProject capability settings: ${JSON.stringify(p)}. Respect disabled capabilities. ${!p.reflection ? "Do not ask for reflection; completion does not require reflection for this project." : ""} ${p.accessibility.simplifiedVocabulary ? "Use familiar words and explain technical terms." : ""} ${p.accessibility.readableFormatting ? "Use short paragraphs, clear spacing and short numbered steps for instructions." : ""}${tutor}` };
		});
		pi.on("input", async (event, ctx) => {
			const blocked = state.limitReached() || (!state.settings.imageUploads && (event.images?.length || /\[Image available at: /m.test(event.text)) ? "Image uploads are disabled for this project." : undefined);
			if (blocked) { state.block("input"); ctx.ui.notify(blocked, "warning"); return { action: "handled" }; }
			// Paseo's uploaded_file renderer emits this header before the host path.
			if (!state.settings.fileUploads && /^Uploaded file: .+\r?\nPath: /m.test(event.text)) {
				state.block("fileUploads"); ctx.ui.notify("File attachments are disabled for this project.", "warning"); return { action: "handled" };
			}
		});
		pi.on("user_bash", async (_event, ctx) => {
			if (state.effective) { state.block("terminal"); ctx.ui.notify("Use the project conversation for commands so project controls can be applied.", "warning"); return { result: { output: "Project controls require commands through the conversation.", exitCode: 1, cancelled: false, truncated: false } }; }
		});
		pi.on("tool_call", async (event, ctx) => {
			const p = state.settings;
			let reason = state.limitReached();
			let capability = "sessionLimits";
			const agentLimit = !reason && state.agentLimitReached();
			if (agentLimit) { capability = "agentLimits"; reason = `${agentLimit} Guide the student instead of changing files or running commands.`; }
			if (!reason && ["write", "edit"].includes(event.toolName) && !p.fileEditing) { capability = "fileEditing"; reason = "File editing is disabled for this project."; }
			if (!reason && event.toolName === "save_to_desktop" && !p.desktopExport) { capability = "desktopExport"; reason = "Desktop export is disabled for this project."; }
			if (!reason && event.toolName === "bash") {
				capability = "terminal";
				if (!p.terminal) reason = "Terminal commands are disabled for this project.";
				else if ((!p.fileEditing || !p.dependencyInstallation) && !isSafeInspectionCommand(String(event.input.command ?? ""), ctx.cwd)) {
					capability = !p.fileEditing ? "fileEditing" : "dependencyInstallation";
					reason = "This project permits only inspection commands while file editing or dependency installation is disabled.";
				}
				else if (!p.internet && !sandbox.setInternetAllowed) reason = "This sandbox cannot enforce the project's internet restriction.";
			}
			if (reason) { state.block(capability); return { block: true, reason }; }
		});
		pi.on("message_end", async (event, ctx) => {
			if (event.message.role !== "assistant") return;
			answer = event.message.content.filter(item => item.type === "text").map(item => item.text).join("\n");
			const tutoring = state.agentLimitReached() !== undefined;
			if (tutoring) state.tutoringTurns++; else state.turns++;
			state.tokens += event.message.usage.totalTokens || 0; state.cost += event.message.usage.cost?.total || 0;
			const reached = state.limitReached();
			if (reached) { ctx.ui.notify(reached, "info"); await ctx.abort(); return; }
			// Stop the agent loop when its limit is reached; the student can keep asking for help.
			const agentReached = !tutoring && state.agentLimitReached();
			if (agentReached) { ctx.ui.notify(`${agentReached} AI tutoring is still available.`, "info"); await ctx.abort(); }
		});
	};
}
