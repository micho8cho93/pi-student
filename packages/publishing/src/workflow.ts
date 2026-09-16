import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectDetection } from "./types.js";

export const PI_WORKFLOW_MARKER = "# Managed by Pi Student";

export async function ensurePagesWorkflow(projectPath: string, project: ProjectDetection, branch = "main"): Promise<{ created: boolean; managed: boolean }> {
	if (project.deploymentType !== "github-actions" || !project.buildCommand || !project.outputDirectory) return { created: false, managed: false };
	const workflowPath = path.join(projectPath, ".github", "workflows", "pi-pages.yml");
	try { await access(workflowPath); return { created: false, managed: await isManaged(workflowPath) }; } catch { /* create below */ }
	await mkdir(path.dirname(workflowPath), { recursive: true });
	const installCommand = await exists(path.join(projectPath, "package-lock.json")) ? "npm ci" : "npm install";
	await writeFile(workflowPath, workflow(project.buildCommand, project.outputDirectory, branch, installCommand));
	return { created: true, managed: true };
}

async function isManaged(filePath: string): Promise<boolean> {
	const { readFile } = await import("node:fs/promises");
	return (await readFile(filePath, "utf8")).includes(PI_WORKFLOW_MARKER);
}

function workflow(buildCommand: string, outputDirectory: string, branch: string, installCommand: string): string {
	return `${PI_WORKFLOW_MARKER}
name: Deploy website to GitHub Pages

on:
  push:
    branches: [${branch}]
  workflow_dispatch:

permissions:
  actions: read
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v6
      - name: Set up Node.js
        uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Configure GitHub Pages
        uses: actions/configure-pages@v5
      - name: Install dependencies
        run: ${installCommand}
      - name: Build website
        run: ${buildCommand}
      - name: Upload GitHub Pages artifact
        uses: actions/upload-pages-artifact@v4
        with:
          path: ${outputDirectory}
  deploy:
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
`;
}

async function exists(filePath: string): Promise<boolean> {
	try { await access(filePath); return true; } catch { return false; }
}
