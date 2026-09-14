import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getInstallationPaths } from "../install/paths.js";
import type { LearningRecord, TeacherContext } from "./types.js";

export interface StoredLearningRecord {
	record: LearningRecord;
	status: "pending" | "synced";
	attempts: number;
	lastError?: string;
	updatedAt: string;
}

export class LearningRecordStore {
	readonly root: string;
	constructor(root = path.join(getInstallationPaths().root, "learning-records")) { this.root = root; }

	async save(record: LearningRecord): Promise<void> {
		const existing = await this.read(record.session.id);
		await this.write({ record, status: "pending", attempts: existing?.attempts ?? 0, updatedAt: new Date().toISOString() });
	}

	async pending(): Promise<StoredLearningRecord[]> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const names = (await readdir(this.root)).filter(name => name.endsWith(".json"));
		const records = await Promise.all(names.map(name => this.read(name.slice(0, -5))));
		return records.filter((value): value is StoredLearningRecord => value?.status === "pending");
	}

	async read(sessionId: string): Promise<StoredLearningRecord | undefined> {
		try { return JSON.parse(await readFile(this.filePath(sessionId), "utf8")) as StoredLearningRecord; }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	async markSynced(sessionId: string): Promise<void> {
		const stored = await this.read(sessionId);
		if (stored) await this.write({ ...stored, status: "synced", lastError: undefined, updatedAt: new Date().toISOString() });
	}

	async markFailed(sessionId: string, error: string): Promise<void> {
		const stored = await this.read(sessionId);
		if (stored) await this.write({ ...stored, status: "pending", attempts: stored.attempts + 1, lastError: error.slice(0, 500), updatedAt: new Date().toISOString() });
	}

	private filePath(sessionId: string): string {
		if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error("Invalid session id");
		return path.join(this.root, `${sessionId}.json`);
	}

	private async write(stored: StoredLearningRecord): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const destination = this.filePath(stored.record.session.id);
		const temporary = `${destination}.${process.pid}.tmp`;
		await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, destination);
	}
}

export async function readTeacherContext(filePath = path.join(getInstallationPaths().config, "teacher-context.json")): Promise<TeacherContext> {
	try { return JSON.parse(await readFile(filePath, "utf8")) as TeacherContext; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export async function writeTeacherContext(context: TeacherContext, filePath = path.join(getInstallationPaths().config, "teacher-context.json")): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	const temporary = `${filePath}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, filePath);
}

