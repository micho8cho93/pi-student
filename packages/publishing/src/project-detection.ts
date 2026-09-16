import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectDetection } from "./types.js";

export async function detectProjectType(projectPath: string): Promise<ProjectDetection> {
	const packagePath = path.join(projectPath, "package.json");
	let packageJson: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined;
	try {
		packageJson = JSON.parse(await readFile(packagePath, "utf8"));
	} catch {
		if (await exists(path.join(projectPath, "index.html"))) {
			return { kind: "static", label: "HTML/CSS/JavaScript", deploymentType: "branch" };
		}
		return { kind: "unsupported", label: "Unsupported project", deploymentType: "branch", reason: "A static website needs an index.html file." };
	}

	if (!packageJson) return { kind: "unsupported", label: "Unsupported project", deploymentType: "branch", reason: "Pi could not read package.json." };
	const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
	if (!packageJson.scripts?.build) {
		return { kind: "unsupported", label: "Unsupported application", deploymentType: "github-actions", reason: "This project has package.json but no build script." };
	}
	if ("astro" in dependencies) return framework("astro", "Astro", "dist");
	if ("@sveltejs/kit" in dependencies) {
		if (!("@sveltejs/adapter-static" in dependencies)) return { kind: "unsupported", label: "SvelteKit application", deploymentType: "github-actions", reason: "SvelteKit needs @sveltejs/adapter-static before it can publish to GitHub Pages." };
		return framework("svelte", "SvelteKit", "build");
	}
	if ("svelte" in dependencies) return framework("svelte", "Svelte", "dist");
	if ("vite" in dependencies) return framework("vite", "Vite", "dist");
	if ("react-scripts" in dependencies) return framework("react", "React", "build");
	return { kind: "unsupported", label: "Unsupported application", deploymentType: "github-actions", reason: "Pi does not yet know which folder this build publishes." };
}

function framework(kind: "vite" | "react" | "astro" | "svelte", label: string, outputDirectory: string): ProjectDetection {
	return { kind, label, deploymentType: "github-actions", buildCommand: "npm run build", outputDirectory };
}

async function exists(filePath: string): Promise<boolean> {
	try { await access(filePath); return true; } catch { return false; }
}
