import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { assertSandboxPath, type SandboxRuntime } from "@pi-student/sandbox/types";
import type { WorkflowController } from "@pi-student/education/workflow-controller";
import { SaveToDesktopParams } from "./tool-parameter-schemas.js";
import { prepareSaveToDesktopArguments } from "./tool-arguments.js";

export const DEFAULT_DESKTOP_EXPORT_LIMIT_BYTES = 100 * 1024 * 1024;

export interface DesktopExportOptions {
	desktopDirectory?: string;
	maxBytes?: number;
}

function result(text: string, details: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

/**
 * The only intentional host-write boundary available to the agent.
 *
 * Project work remains inside SandboxRuntime. Once the workflow has recorded a
 * passing verification result, this extension can copy one immutable snapshot
 * of a workspace file to the user's Desktop after an explicit confirmation.
 */
export function createSaveToDesktopExtension(
	workflow: WorkflowController,
	sandbox: SandboxRuntime,
	options: DesktopExportOptions = {},
): ExtensionFactory {
	const desktopDirectory = path.resolve(options.desktopDirectory ?? path.join(os.homedir(), "Desktop"));
	const maxBytes = options.maxBytes ?? DEFAULT_DESKTOP_EXPORT_LIMIT_BYTES;

	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "save_to_desktop",
			label: "Save to Desktop",
			description: "Publish a verified file from the sandbox workspace to the user's Desktop.",
			promptSnippet: "Save a verified sandbox artifact to the user's Desktop after confirmation.",
			promptGuidelines: [
				"Use only after verification has passed and only for files the user needs outside the project.",
				"Never claim the export succeeded unless this tool reports the saved filename.",
			],
			parameters: SaveToDesktopParams,
			prepareArguments: prepareSaveToDesktopArguments,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				try {
					if (workflow.state.verification.passed !== true) {
						return result("The file cannot be saved to the Desktop until verification passes.", { source: params.source }, true);
					}
					if (!ctx.hasUI) {
						return result("Saving outside the sandbox requires an interactive user confirmation.", { source: params.source }, true);
					}

					const source = assertSandboxPath(params.source);
					const sourceInfo = sandbox.stat ? await sandbox.stat(source) : undefined;
					if (sourceInfo?.isDirectory()) {
						return result("Save a file, not a directory. Create a verified archive first if multiple files are needed.", { source }, true);
					}
					if (!(await sandbox.fileExists(source))) {
						return result(`Sandbox file not found: ${source}`, { source }, true);
					}

					const filename = validateDesktopFilename(params.filename?.trim() || path.posix.basename(source));
					const bytes = Buffer.from(sandbox.readBytes ? await sandbox.readBytes(source) : await sandbox.readFile(source));
					if (bytes.byteLength > maxBytes) {
						return result(
							`The file is ${formatBytes(bytes.byteLength)}, above the ${formatBytes(maxBytes)} Desktop export limit.`,
							{ source, filename, size: bytes.byteLength, maxBytes },
							true,
						);
					}

					const sha256 = createHash("sha256").update(bytes).digest("hex");
					const confirmed = await ctx.ui.confirm(
						"Save verified file to Desktop?",
						`${filename}\n\nSource: ${source}\nSize: ${formatBytes(bytes.byteLength)}\nSHA-256: ${sha256}`,
					);
					if (!confirmed) return result("The user cancelled the Desktop export.", { source, filename });

					await mkdir(desktopDirectory, { recursive: true });
					const destination = path.join(desktopDirectory, filename);
					await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
					return result(
						`Saved the verified file as Desktop/${filename}.`,
						{ source, filename, size: bytes.byteLength, sha256 },
					);
				} catch (error) {
					const message = error instanceof Error && "code" in error && error.code === "EEXIST"
						? "A file with that name already exists on the Desktop. Choose a different filename; existing files are never overwritten."
						: error instanceof Error ? error.message : String(error);
					return result(message, { source: params.source, filename: params.filename }, true);
				}
			},
		});
	};
}

function validateDesktopFilename(candidate: string): string {
	if (!candidate || candidate === "." || candidate === ".." || candidate.includes("/") || candidate.includes("\\") || candidate.includes("\0")) {
		throw new Error("Desktop filename must be a single non-empty filename without path separators.");
	}
	return candidate;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
