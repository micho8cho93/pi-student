import path from "node:path";
import { createHash } from "node:crypto";
import type { SandboxRuntime } from "@pi-student/sandbox/types";

export interface Evidence { file: string; line?: number; confidence: "confirmed" | "inferred"; }
export interface ModelFact { name: string; kind: string; evidence: Evidence; }
export interface Relationship { from: string; to: string; kind: "imports" | "dependency"; evidence: Evidence; }
export interface SourceSummary { file: string; fingerprint: string; symbols: string[]; routes: string[]; }
export interface ProjectModel {
	version: 1;
	generation: number;
	coverage: { filesListed: number; filesInspected: number; truncated: boolean; errors: string[] };
	languages: string[];
	technologies: ModelFact[];
	packages: ModelFact[];
	entryPoints: ModelFact[];
	directories: string[];
	patterns: ModelFact[];
	scripts: { file: string; name: string; command: string }[];
	relationships: Relationship[];
	sources: SourceSummary[];
}
const EXCLUDED = /^(\.git|node_modules|dist|build|coverage|vendor|\.venv|venv|\.next|__pycache__)$/;
const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|CMakeLists\.txt|Makefile|docker-compose\.ya?ml|compose\.ya?ml|Dockerfile)$/;
const SOURCE = /\.(tsx?|jsx?|mjs|cjs|py|rs|go|java|c|cpp|h|css|sql)$/;
const LANGUAGE: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", py: "Python", rs: "Rust", go: "Go", java: "Java", c: "C", cpp: "C++", css: "CSS", sql: "SQL" };
const TECHNOLOGIES: Record<string, string> = { react: "UI library", vue: "UI framework", svelte: "UI framework", next: "Application framework", vite: "Build tool", typescript: "Language tooling", express: "HTTP server", fastify: "HTTP server", flask: "HTTP server", django: "Application framework", fastapi: "HTTP server", prisma: "ORM", "@prisma/client": "ORM", pg: "Database client", redis: "Cache client", ioredis: "Cache client", ws: "WebSocket library", "socket.io": "Realtime library", vitest: "Test runner", pytest: "Test runner", webpack: "Bundler", sqlalchemy: "ORM", "@supabase/supabase-js": "Service client" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

/** One bounded, sandbox-only model per running session; no recursive repository dump. */
export class CodebaseModel {
	private model?: ProjectModel;
	private files: string[] = [];
	private scannedAt = 0;
	private pending?: Promise<ProjectModel>;
	constructor(private readonly runtime: SandboxRuntime, private readonly now = Date.now) {}
	invalidate(): void { this.scannedAt = 0; this.model = undefined; }
	async get(refresh = false): Promise<ProjectModel> {
		if (this.pending) return this.pending;
		if (!refresh && this.model && this.now() - this.scannedAt < 60_000) return this.model;
		this.pending = this.scan().finally(() => { this.pending = undefined; });
		return this.pending;
	}
	private async scan(): Promise<ProjectModel> {
		const model: ProjectModel = { version: 1, generation: (this.model?.generation ?? 0) + 1, coverage: { filesListed: 0, filesInspected: 0, truncated: false, errors: [] }, languages: [], technologies: [], packages: [], entryPoints: [], directories: [], patterns: [], scripts: [], relationships: [], sources: [] };
		this.files = [];
		const queue = [{ directory: "", depth: 0 }];
		let visited = 0;
		while (queue.length && visited++ < 60 && this.files.length < 1200) {
			const { directory, depth } = queue.shift()!;
			if (!this.runtime.listDirectory) { model.coverage.errors.push("Shallow directory listing is unavailable."); break; }
			let names: string[];
			try { names = await this.runtime.listDirectory(this.absolute(directory)); }
			catch { model.coverage.errors.push(`Cannot list ${directory || "."}`); continue; }
			if (names.length > 200) model.coverage.truncated = true;
			for (const name of names.sort().slice(0, 200)) {
				if (EXCLUDED.test(name) || name.startsWith(".") || name.includes("/") || name.includes("\\")) continue;
				const file = path.posix.join(directory, name);
				const isDirectory = this.runtime.stat ? await this.runtime.stat(this.absolute(file)).then(s => s.isDirectory()).catch(() => false) : !name.includes(".");
				if (isDirectory) {
					if (model.directories.length < 240) model.directories.push(file);
					else model.coverage.truncated = true;
					if (depth < 3 && queue.length < 1200) queue.push({ directory: file, depth: depth + 1 });
					else model.coverage.truncated = true;
				} else if (this.files.length < 1200) this.files.push(file);
				else model.coverage.truncated = true;
			}
		}
		model.coverage.truncated ||= queue.length > 0;
		model.coverage.filesListed = this.files.length;
		model.languages = [...new Set(this.files.map(f => LANGUAGE[f.split(".").pop()!]).filter(Boolean))].sort();
		const manifests = this.files.filter(f => MANIFEST.test(f));
		model.coverage.truncated ||= manifests.length > 24;
		for (const file of manifests.slice(0, 24)) {
			try {
				const text = await this.runtime.readFile(this.absolute(file));
				if (text.length > 64_000) { model.coverage.errors.push(`Manifest too large: ${file}`); continue; }
				model.coverage.filesInspected++;
				this.manifest(model, file, text);
			} catch { model.coverage.errors.push(`Cannot parse ${file}`); }
		}
		for (const file of this.files.filter(f => /(^|\/)(main|index|server|app|__main__)\.(tsx?|jsx?|py|rs|go)$/.test(f)).slice(0, 24)) {
			model.entryPoints.push({ name: file, kind: "Possible entry point; inspect before tracing", evidence: { file, confidence: "inferred" } });
		}
		if (model.packages.length > 1) model.patterns.push({ name: "Multiple packages", kind: "Possible monorepo", evidence: { ...model.packages[0].evidence, confidence: "inferred" } });
		// Retain only previously explored source facts whose content still matches.
		for (const source of this.model?.sources ?? []) {
			try {
				const current = await this.runtime.readFile(this.absolute(source.file));
				if (hash(current) !== source.fingerprint) continue;
				model.sources.push(source);
				model.relationships.push(...this.model!.relationships.filter(r => r.kind === "imports" && r.from === source.file));
			} catch { /* Deleted or inaccessible files lose their facts. */ }
		}
		model.coverage.filesInspected += model.sources.length;
		if (model.relationships.length > 600) { model.relationships = model.relationships.slice(0, 600); model.coverage.truncated = true; }
		this.model = model;
		this.scannedAt = this.now();
		return model;
	}
	private manifest(model: ProjectModel, file: string, text: string): void {
		const evidence: Evidence = { file, confidence: "confirmed" };
		if (/(package.json|pyproject.toml|Cargo.toml|go.mod|pom.xml)$/.test(file)) model.packages.push({ name: path.posix.dirname(file), kind: "Manifest boundary", evidence });
		if (/(Dockerfile|compose\.ya?ml)$/.test(file)) {
			model.technologies.push({ name: "Containers", kind: "Infrastructure configuration", evidence });
			for (const name of ["postgres", "redis", "mysql", "mongo"]) if (new RegExp(`image:\\s*${name}[:\\s]`).test(text)) model.technologies.push({ name, kind: "Configured service (runtime availability unknown)", evidence });
		}
		if (file.endsWith("package.json")) {
			const json = JSON.parse(text);
			for (const [name, command] of Object.entries(json.scripts ?? {})) if (typeof command === "string") model.scripts.push({ file, name, command });
			for (const [name] of Object.entries({ ...json.dependencies, ...json.devDependencies })) {
				model.relationships.push({ from: file, to: name, kind: "dependency", evidence });
				if (TECHNOLOGIES[name]) model.technologies.push({ name, kind: TECHNOLOGIES[name], evidence });
			}
			for (const entry of [json.main, json.module, ...(typeof json.bin === "string" ? [json.bin] : Object.values(json.bin ?? {}))]) if (typeof entry === "string") model.entryPoints.push({ name: path.posix.join(path.posix.dirname(file), entry), kind: "Declared entry point", evidence });
			if (json.workspaces) model.patterns.push({ name: "Workspace packages", kind: "Monorepo configuration", evidence });
		} else {
			for (const [name, kind] of Object.entries(TECHNOLOGIES)) if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) model.technologies.push({ name, kind: `${kind} (manifest reference)`, evidence });
		}
	}
	private absolute(file: string): string {
		const root = this.runtime.getWorkspacePath();
		const resolved = path.posix.resolve(root, file);
		if (resolved !== root && !resolved.startsWith(root + "/")) throw new Error("File is outside the project.");
		return resolved;
	}
	async inspect(file: string): Promise<{ model: ProjectModel; file: string; excerpt: string }> {
		const absolute = this.absolute(file);
		file = path.posix.relative(this.runtime.getWorkspacePath(), absolute);
		if (!SOURCE.test(file) || file.split("/").some(part => EXCLUDED.test(part) || part.startsWith("."))) throw new Error("Choose a project source file; hidden files and generated dependencies are excluded.");
		const model = await this.get();
		const text = await this.runtime.readFile(absolute);
		if (text.length > 96_000) throw new Error("File exceeds the analysis limit; use read with a line range instead.");
		const lines = text.split("\n");
		const summary: SourceSummary = { file, fingerprint: hash(text), symbols: [], routes: [] };
		model.relationships = model.relationships.filter(r => r.kind !== "imports" || r.from !== file);
		for (const [index, line] of lines.entries()) {
			const imported = line.match(/(?:from\s+|import\s*\(?|require\s*\()\s*["']([^"']+)["']/)?.[1] ?? line.match(/^\s*(?:from|import)\s+([\w.]+)/)?.[1];
			if (imported) model.relationships.push({ from: file, to: imported, kind: "imports", evidence: { file, line: index + 1, confidence: "confirmed" } });
			const symbol = line.match(/(?:function|class|def|fn|func)\s+(\w+)/)?.[1];
			if (symbol) summary.symbols.push(`${symbol}:${index + 1}`);
			const route = line.match(/\.(?:get|post|put|delete|patch|route)\(\s*["']([^"']+)/)?.[1];
			if (route) summary.routes.push(`${route}:${index + 1}`);
		}
		model.sources = model.sources.filter(s => s.file !== file);
		model.sources.push(summary);
		if (model.sources.length > 32) {
			const evicted = model.sources.shift()!;
			model.relationships = model.relationships.filter(r => r.kind !== "imports" || r.from !== evicted.file);
		}
		model.coverage.filesInspected = model.packages.length + model.sources.length;
		return { model, file, excerpt: lines.slice(0, 180).map((line, i) => `${i + 1}: ${line}`).join("\n"), };
	}
	/** Follow observed local imports with a hard file budget. Runtime ordering still requires code interpretation. */
	async trace(file: string): Promise<{ kind: string; files: string[]; relationships: Relationship[]; unresolved: string[]; truncated: boolean }> {
		await this.get();
		const queue = [path.posix.relative(this.runtime.getWorkspacePath(), this.absolute(file))];
		const visited = new Set<string>();
		const relationships: Relationship[] = [];
		const unresolved = new Set<string>();
		while (queue.length && visited.size < 8) {
			const current = queue.shift()!;
			if (visited.has(current)) continue;
			visited.add(current);
			const { model } = await this.inspect(current);
			for (const edge of model.relationships.filter(r => r.kind === "imports" && r.from === current)) {
				relationships.push(edge);
				const base = edge.to.startsWith(".") ? path.posix.join(path.posix.dirname(current), edge.to) : current.endsWith(".py") ? edge.to.replaceAll(".", "/") : undefined;
				const candidates = base ? [base, base.replace(/\.js$/, ".ts"), base + ".ts", base + ".tsx", base + ".js", base + ".jsx", base + ".py", base + "/index.ts", base + "/index.js", base + "/__init__.py"] : [];
				const resolved = candidates.find(candidate => this.files.includes(candidate));
				if (resolved && !visited.has(resolved)) queue.push(resolved);
				else if (!resolved) unresolved.add(edge.to);
			}
		}
		return { kind: "Observed dependency trace, not runtime call order", files: [...visited], relationships, unresolved: [...unresolved], truncated: queue.length > 0 };
	}

	async search(query: string): Promise<string[]> {
		await this.get();
		const words = query.toLowerCase().split(/\W+/).filter(Boolean);
		return this.files.filter(f => SOURCE.test(f) && words.some(w => f.toLowerCase().includes(w))).slice(0, 30);
	}
}

/** Import edges are dependencies, never asserted to be runtime execution traces. */
export function relationshipDiagram(model: ProjectModel, focus?: string): string {
	const edges = model.relationships.filter(r => !focus || r.from.includes(focus) || r.to.includes(focus)).slice(0, 24);
	return edges.length ? edges.map(r => `${r.from}\n  └─ ${r.kind} → ${r.to}  [${r.evidence.file}${r.evidence.line ? ":" + r.evidence.line : ""}]`).join("\n") : "No relationships inspected yet. Search for a feature and inspect its source files.";
}
