import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowchartNodeSelection, WorkspaceMapStatus } from "@pi-student/contracts";
import { isSensitiveContextPath } from "@pi-student/shared/file-context";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";
import { FLOWCHART_EXCLUDED_NAME, FLOWCHART_IGNORED_DIRECTORIES, FLOWCHART_IMPORTANT_NAME, FLOWCHART_SOURCE_EXTENSION, workspaceEventKey,
	type WorkspaceEventScope } from "./workspace-events.js";

export const MAX_FLOWCHART_SOURCES = 100;
const MAX_SOURCE_BYTES = 2_000_000;

/**
 * Project files the flowchart is generated from, as absolute paths, in a stable
 * order. Generation and staleness checks share this one definition, so a map is
 * stale exactly when a file it could have read changed, appeared or disappeared.
 * Returns at most `limit + 1` files so callers can tell the listing was truncated.
 */
export async function listFlowchartSources(root: string, limit = MAX_FLOWCHART_SOURCES): Promise<string[]> {
	const files: string[] = [];
	const visit = async (directory: string, depth: number): Promise<void> => {
		if (depth > 7 || files.length >= limit + 1) return;
		let entries;
		try { entries = await readdir(directory, { withFileTypes: true }); }
		catch { return; }
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".") || isSensitiveContextPath(path.join(directory, entry.name)) || FLOWCHART_EXCLUDED_NAME.test(entry.name)) continue;
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				if (!FLOWCHART_IGNORED_DIRECTORIES.has(entry.name)) await visit(full, depth + 1);
			} else if (entry.isFile() && (FLOWCHART_SOURCE_EXTENSION.test(entry.name) || FLOWCHART_IMPORTANT_NAME.test(entry.name))) files.push(full);
			if (files.length >= limit + 1) break;
		}
	};
	await visit(root, 0);
	return files;
}

export const digestSource = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

/** Content digests of the flowchart's candidate sources, keyed by project-relative path. Never contents. */
export async function flowchartSourceDigests(root: string): Promise<Record<string, string>> {
	const digests: Record<string, string> = {};
	for (const file of (await listFlowchartSources(root)).slice(0, MAX_FLOWCHART_SOURCES)) {
		try {
			if ((await stat(file)).size > MAX_SOURCE_BYTES) continue;
			digests[path.relative(root, file).split(path.sep).join("/")] = digestSource(await readFile(file));
		} catch { /* A file removed during the scan is simply absent. */ }
	}
	return digests;
}

/** The parts of a generated flowchart the workspace relies on. The rest of the chart is stored as generated. */
export interface StoredFlowchart {
	nodes: FlowchartNodeSelection[];
	edges: readonly unknown[];
	generatedAt: string;
	filesRead?: number;
	model?: string;
}

interface StoredMap<Chart extends StoredFlowchart> {
	version: 1;
	workspace: string;
	chart: Chart;
	sources: Record<string, string>;
	selectedNodeId?: string;
}

const RELATIVE = (value: unknown) => typeof value === "string" && value.length > 0 && value.length < 2_000 && !value.startsWith("/") && !value.split("/").includes("..");

/**
 * Generated maps, persisted per student project (the workspace event key), so a
 * map survives reloads, project switches and restarts, and never appears in
 * another project or for another student. Writes are atomic and happen only
 * after a successful generation, so a failed refresh keeps the last valid map.
 * Reading a map never needs AI.
 */
export class WorkspaceMapStore {
	constructor(readonly directory = path.join(getInstallationPaths().config, "workspace-maps")) {}

	private file(scope: WorkspaceEventScope) { return path.join(this.directory, `${workspaceEventKey(scope)}.json`); }

	async read<Chart extends StoredFlowchart = StoredFlowchart>(scope: WorkspaceEventScope): Promise<StoredMap<Chart> | undefined> {
		let value: StoredMap<Chart>;
		try { value = JSON.parse(await readFile(this.file(scope), "utf8")); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
			throw error;
		}
		// A copied or corrupted file for another workspace is ignored, never shown.
		if (value?.version !== 1 || value.workspace !== workspaceEventKey(scope) || !Array.isArray(value.chart?.nodes) || !Array.isArray(value.chart?.edges)
			|| typeof value.chart.generatedAt !== "string" || !value.sources || typeof value.sources !== "object"
			|| !Object.entries(value.sources).every(([file, digest]) => RELATIVE(file) && typeof digest === "string")) return undefined;
		return value;
	}

	async save<Chart extends StoredFlowchart>(scope: WorkspaceEventScope, chart: Chart, sources: Record<string, string>): Promise<void> {
		const previous = await this.read(scope).catch(() => undefined);
		// Keep the student's selection when the regenerated map still has that step.
		const selectedNodeId = previous?.selectedNodeId && chart.nodes.some(node => node.id === previous.selectedNodeId) ? previous.selectedNodeId : undefined;
		await this.write(scope, { version: 1, workspace: workspaceEventKey(scope), chart, sources, ...(selectedNodeId ? { selectedNodeId } : {}) });
	}

	/** Remembers the selected step; ignored when there is no map or the step is not in it. */
	async select(scope: WorkspaceEventScope, nodeId: string | undefined): Promise<void> {
		const stored = await this.read(scope);
		if (!stored || (nodeId !== undefined && !stored.chart.nodes.some(node => node.id === nodeId))) return;
		if (stored.selectedNodeId === nodeId) return;
		const { selectedNodeId: _previous, ...rest } = stored;
		await this.write(scope, nodeId ? { ...rest, selectedNodeId: nodeId } : rest);
	}

	async remove(scope: WorkspaceEventScope): Promise<void> { await rm(this.file(scope), { force: true }); }

	/** The stored map's status, with staleness computed from the project files as they are now. */
	async status(scope: WorkspaceEventScope): Promise<WorkspaceMapStatus> {
		const stored = await this.read(scope);
		if (!stored) return { available: false, stale: false, staleFiles: [] };
		const current = await flowchartSourceDigests(scope.projectPath);
		const staleFiles = [...new Set([...Object.keys(stored.sources), ...Object.keys(current)])]
			.filter(file => stored.sources[file] !== current[file] && !isSensitiveContextPath(file)).sort().slice(0, 20);
		const node = stored.chart.nodes.find(item => item.id === stored.selectedNodeId);
		return {
			available: true, generatedAt: stored.chart.generatedAt, stale: staleFiles.length > 0, staleFiles,
			...(node ? { selectedNode: selection(node) } : {}),
			...(typeof stored.chart.filesRead === "number" ? { filesRead: stored.chart.filesRead } : {}),
			...(typeof stored.chart.model === "string" ? { model: stored.chart.model } : {}),
		};
	}

	private async write(scope: WorkspaceEventScope, value: StoredMap<StoredFlowchart>): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const target = this.file(scope);
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await rename(temporary, target);
	}
}

function selection(node: FlowchartNodeSelection): FlowchartNodeSelection {
	const { id, label, file, symbol, line } = node;
	const relatedFiles = Array.isArray(node.relatedFiles) ? node.relatedFiles.filter(item => typeof item === "string" && !isSensitiveContextPath(item)) : [];
	return { id, label, ...(file && !isSensitiveContextPath(file) ? { file } : {}), ...(symbol ? { symbol } : {}), ...(line ? { line } : {}),
		...(relatedFiles.length ? { relatedFiles } : {}) };
}
