import path from "node:path";
import type { SandboxRuntime } from "@pi-student/sandbox/types";
import { isSensitiveContextPath } from "@pi-student/shared/file-context";

/** A compact snapshot used to make routing and student questions more useful. */
export interface ProjectContext {
	languages: string[];
	frameworks: string[];
	projectType?: string;
	packageManager?: string;
	testFramework?: string;
	hasGit: boolean;
	importantFiles: string[];
	classContext?: string;
}

const IMPORTANT_FILES = [
	"README.md",
	"package.json",
	"pyproject.toml",
	"requirements.txt",
	"Cargo.toml",
	"go.mod",
	"pom.xml",
	"build.gradle",
	"index.html",
	"src",
	"tests",
	"test",
	"CLASS.md",
] as const;

/**
 * Inspect only lightweight project signals. This deliberately avoids running
 * project code or reading every source file before the student is asked a
 * question round.
 */
export async function inspectProjectContext(runtime: SandboxRuntime): Promise<ProjectContext> {
	const files = await discoverProjectFiles(runtime);
	const relativeFiles = files
		.map((file) => path.posix.relative(runtime.getWorkspacePath(), file))
		.filter(Boolean)
		.filter((file) => !file.startsWith(".git/") && !file.startsWith("node_modules/") && !isSensitiveContextPath(file));
	const fileSet = new Set(relativeFiles);
	const importantFiles = relativeFiles
		.filter((file) => IMPORTANT_FILES.includes(file as (typeof IMPORTANT_FILES)[number]) || /^(src|tests?|app)\/[^/]+\.(ts|tsx|js|jsx|py|rs|go|java)$/.test(file))
		.slice(0, 40);

	const packageJson = await readJson(runtime, "/workspace/package.json");
	const pyproject = await readText(runtime, "/workspace/pyproject.toml");
	const requirements = await readText(runtime, "/workspace/requirements.txt");
	const cargo = await readText(runtime, "/workspace/Cargo.toml");
	const classContext = await readText(runtime, "/workspace/CLASS.md", 12_000);

	const languages = new Set<string>();
	for (const file of relativeFiles) {
		const extension = path.posix.extname(file).toLowerCase();
		const language = extensionLanguage(extension);
		if (language) languages.add(language);
	}
	if (packageJson) languages.add("JavaScript/TypeScript");
	if (pyproject || requirements) languages.add("Python");
	if (cargo) languages.add("Rust");

	const frameworks = new Set<string>();
	const dependencies = {
		...asRecord(packageJson?.dependencies),
		...asRecord(packageJson?.devDependencies),
	};
	for (const name of Object.keys(dependencies)) {
		const framework = frameworkName(name);
		if (framework) frameworks.add(framework);
	}
	for (const marker of ["next.config.js", "next.config.mjs", "vite.config.ts", "astro.config.mjs", "angular.json", "manage.py"]) {
		if (fileSet.has(marker)) {
			const framework = marker.startsWith("next") ? "Next.js" : marker.startsWith("vite") ? "Vite" : marker.startsWith("astro") ? "Astro" : marker === "angular.json" ? "Angular" : "Django";
			frameworks.add(framework);
		}
	}

	const packageManager = packageJson
		? fileSet.has("pnpm-lock.yaml") ? "pnpm" : fileSet.has("yarn.lock") ? "Yarn" : fileSet.has("bun.lockb") || fileSet.has("bun.lock") ? "Bun" : "npm"
		: undefined;
	const testFramework = detectTestFramework(packageJson, relativeFiles, requirements);

	return {
		languages: [...languages].sort(),
		frameworks: [...frameworks].sort(),
		projectType: inferProjectType(relativeFiles, packageJson, pyproject, cargo),
		packageManager,
		testFramework,
		hasGit: await runtime.fileExists("/workspace/.git").catch(() => false),
		importantFiles,
		...(classContext ? { classContext } : {}),
	};
}

export function projectContextFacts(context: ProjectContext): string[] {
	const facts: string[] = [];
	if (context.languages.length) facts.push(`The project uses ${context.languages.join(", ")}.`);
	if (context.frameworks.length) facts.push(`Detected framework or library: ${context.frameworks.join(", ")}.`);
	if (context.projectType) facts.push(`Project type: ${context.projectType}.`);
	if (context.packageManager) facts.push(`Package manager: ${context.packageManager}.`);
	if (context.testFramework) facts.push(`Test setup: ${context.testFramework}.`);
	if (context.hasGit) facts.push("This workspace is a Git repository.");
	if (context.importantFiles.length) facts.push(`Important files include ${context.importantFiles.slice(0, 8).join(", ")}.`);
	return facts;
}

async function readText(runtime: SandboxRuntime, filePath: string, maxLength = 20_000): Promise<string | undefined> {
	try {
		const value = await runtime.readFile(filePath);
		return value.slice(0, maxLength);
	} catch {
		return undefined;
	}
}

async function readJson(runtime: SandboxRuntime, filePath: string): Promise<Record<string, unknown> | undefined> {
	const text = await readText(runtime, filePath);
	if (!text) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return asRecord(value);
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function extensionLanguage(extension: string): string | undefined {
	if ([".ts", ".tsx"].includes(extension)) return "TypeScript";
	if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "JavaScript";
	if (extension === ".py") return "Python";
	if (extension === ".rs") return "Rust";
	if (extension === ".go") return "Go";
	if ([".java", ".kt"].includes(extension)) return "Java";
	if ([".html", ".css"].includes(extension)) return "HTML/CSS";
	if ([".c", ".h", ".cpp", ".hpp"].includes(extension)) return "C/C++";
	return undefined;
}

function frameworkName(name: string): string | undefined {
	if (name === "react" || name === "react-dom") return "React";
	if (name === "next") return "Next.js";
	if (name === "vue") return "Vue";
	if (name === "svelte") return "Svelte";
	if (name === "express") return "Express";
	if (name === "fastify") return "Fastify";
	if (name === "astro") return "Astro";
	if (name === "@angular/core") return "Angular";
	if (name === "tailwindcss") return "Tailwind CSS";
	if (name === "vite") return "Vite";
	return undefined;
}

function detectTestFramework(packageJson: Record<string, unknown> | undefined, files: string[], requirements?: string): string | undefined {
	const dependencies = { ...asRecord(packageJson?.dependencies), ...asRecord(packageJson?.devDependencies) };
	for (const [name, label] of [["vitest", "Vitest"], ["jest", "Jest"], ["mocha", "Mocha"], ["pytest", "pytest"], ["playwright", "Playwright"]] as const) {
		if (dependencies[name] !== undefined) return label;
	}
	if (files.some((file) => /(^|\/)(test|tests)\/.*\.py$/.test(file)) || /(^|\s)pytest([<=>\s]|$)/m.test(requirements ?? "")) return "pytest";
	if (files.some((file) => /(^|\/)(test|tests)\/.*\.(ts|tsx|js|jsx)$/.test(file))) return "project test files detected";
	return undefined;
}

function inferProjectType(files: string[], packageJson: Record<string, unknown> | undefined, pyproject?: string, cargo?: string): string | undefined {
	if (files.includes("index.html") && files.some((file) => file.endsWith(".css"))) return "web project";
	if (packageJson?.scripts && typeof packageJson.scripts === "object") return "JavaScript/TypeScript application";
	if (pyproject) return "Python project";
	if (cargo) return "Rust project";
	if (files.some((file) => file.endsWith(".py"))) return "Python project";
	return undefined;
}

/** Bound discovery to top-level manifests and immediate source/test entries. */
async function discoverProjectFiles(runtime: SandboxRuntime): Promise<string[]> {
	if (!runtime.listDirectory) return []; // Never fall back to an unbounded recursive scan.
	const root = runtime.getWorkspacePath();
	const names: string[] = await runtime.listDirectory(root).catch((): string[] => []);
	const files = names.slice(0, 200).map(name => path.posix.join(root, name));
	for (const directory of ["src", "app", "tests", "test"]) {
		if (!names.includes(directory)) continue;
		const children = await runtime.listDirectory(path.posix.join(root, directory)).catch(() => []);
		files.push(...children.slice(0, 200).map(name => path.posix.join(root, directory, name)));
	}
	return files;
}
