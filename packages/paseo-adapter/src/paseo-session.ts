import { readFile } from "node:fs/promises";
import path from "node:path";
import { PASEO_PROVIDER_ID } from "./config.js";

/** Resolve only a registered Pi agent in the selected workspace; never accept a host path from the browser. */
export async function resolveLearnSession(paseoHome: string | undefined, projectPath: string, workspaceId: string | null, agentId: string | null): Promise<string> {
	if (!paseoHome || !workspaceId || !agentId || !/^[A-Za-z0-9_-]{1,100}$/.test(agentId)) throw new Error("Select an existing Pi conversation first.");
	// Paseo 0.8's AgentStorage.projectDirNameFromCwd convention.
	const { root } = path.win32.parse(projectPath);
	const withoutRoot = projectPath.slice(root.length).replace(/[\\/]+$/, "");
	const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
	const directory = withoutRoot ? (sanitizedRoot ? sanitizedRoot + "-" : "") + withoutRoot.replace(/[\\/]+/g, "-") : sanitizedRoot || "root";
	const record = JSON.parse(await readFile(path.join(paseoHome, "agents", directory, `${agentId}.json`), "utf8"));
	if (record.id !== agentId || record.provider !== PASEO_PROVIDER_ID || record.workspaceId !== workspaceId || path.resolve(record.cwd) !== path.resolve(projectPath) || record.archivedAt) throw new Error("This conversation is not an active Pi session in this workspace.");
	const sessionId = record.runtimeInfo?.sessionId ?? record.persistence?.sessionId;
	if (typeof sessionId !== "string" || !sessionId) throw new Error("Pi is still initializing this conversation. Try again when it is ready.");
	return sessionId;
}
