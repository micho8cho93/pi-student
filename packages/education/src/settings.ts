import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";

/** Host-owned preferences, scoped to the existing Pi session, never project files. */
export class LearnSettingsStore {
	constructor(private readonly directory = path.join(getInstallationPaths().config, "chat-settings")) {}
	private file(project: string, session: string): string {
		return path.join(this.directory, createHash("sha256").update(JSON.stringify([path.resolve(project), session])).digest("hex") + ".json");
	}
	async read(project: string, session: string): Promise<boolean> {
		try { return JSON.parse(await readFile(this.file(project, session), "utf8")).learnMode === true; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
	}
	async write(project: string, session: string, learnMode: boolean): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const file = this.file(project, session);
		const temporary = `${file}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify({ learnMode }), { mode: 0o600 });
		await rename(temporary, file);
	}
}
