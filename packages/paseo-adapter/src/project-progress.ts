import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LearningSession } from "@pi-student/education/types";
import { isLearningStage } from "@pi-student/education/stage";
import { learningProgress } from "@pi-student/runtime/workspace-snapshot";
import type { WorkspaceLearningProgress } from "@pi-student/contracts";
import { PASEO_PROVIDER_ID } from "./config.js";

/** Read the controller's persisted snapshot. This is a view of learning state, not another progress store. */
export async function readProjectProgress(paseoHome: string | undefined, projectPath: string, workspaceId: string | null, agentId: string | null): Promise<WorkspaceLearningProgress | null> {
	if (!paseoHome || !workspaceId || !agentId || !/^[A-Za-z0-9_-]{1,100}$/.test(agentId)) return null;
	const { root } = path.win32.parse(projectPath);
	const withoutRoot = projectPath.slice(root.length).replace(/[\\/]+$/, "");
	const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
	const directory = withoutRoot ? (sanitizedRoot ? sanitizedRoot + "-" : "") + withoutRoot.replace(/[\\/]+/g, "-") : sanitizedRoot || "root";
	let record: { id?: string; provider?: string; workspaceId?: string; cwd?: string; archivedAt?: string; persistence?: { nativeHandle?: string } };
	try { record = JSON.parse(await readFile(path.join(paseoHome, "agents", directory, `${agentId}.json`), "utf8")); }
	catch { return null; }
	if (record.id !== agentId || record.provider !== PASEO_PROVIDER_ID || record.workspaceId !== workspaceId ||
		path.resolve(record.cwd ?? "") !== path.resolve(projectPath) || record.archivedAt) return null;
	const sessionFile = record.persistence?.nativeHandle;
	if (!sessionFile || !path.isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return null;
	let lines: string[];
	try { lines = (await readFile(sessionFile, "utf8")).trim().split("\n"); }
	catch { return null; }
	for (const line of lines.reverse()) {
		let entry: { type?: string; customType?: string; data?: LearningSession };
		try { entry = JSON.parse(line); } catch { continue; }
		const state = entry.data;
		if (entry.type !== "custom" || entry.customType !== "pi-student-workflow" || !state ||
			path.resolve(state.cwd ?? "") !== path.resolve(projectPath) || !isLearningStage(state.stage)) continue;
		return learningProgress(state);
	}
	return null;
}
