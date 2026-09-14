import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Commands intentionally outside Pi Student's student-facing interface. */
export const DISABLED_STUDENT_SLASH_COMMANDS = new Set([
	"share",
	"name",
	"changelog",
	"resume",
	"reload",
	"stage",
	"status",
	"themes",
	"decision",
	"blocker",
	"question",
	"skill",
]);

/** Remove disabled Pi built-ins from autocomplete and command discovery. */
export async function disablePiStudentSlashCommands(): Promise<void> {
	const packageEntry = fileURLToPath(await import.meta.resolve("@earendil-works/pi-coding-agent"));
	const slashCommandsModule = await import(pathToFileURL(path.join(path.dirname(packageEntry), "core", "slash-commands.js")).href);
	const commands = slashCommandsModule.BUILTIN_SLASH_COMMANDS as Array<{ name: string }>;
	for (let index = commands.length - 1; index >= 0; index -= 1) {
		if (DISABLED_STUDENT_SLASH_COMMANDS.has(commands[index].name)) commands.splice(index, 1);
	}
}

export function isDisabledStudentSlashCommand(text: string): boolean {
	const command = text.trim().match(/^\/([^\s]+)/u)?.[1]?.toLowerCase();
	return command ? DISABLED_STUDENT_SLASH_COMMANDS.has(command) : false;
}
