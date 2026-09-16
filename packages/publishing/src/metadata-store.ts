import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { getInstallationPaths } from "@pi-student/shared/installation-paths";
import type { ProjectPublishingMetadata } from "./types.js";

export class PublishingMetadataStore {
	constructor(private readonly root = path.join(getInstallationPaths().config, "projects")) {}

	async read(projectPath: string): Promise<ProjectPublishingMetadata | undefined> {
		try {
			const parsed = JSON.parse(await readFile(await this.filePath(projectPath), "utf8")) as ProjectPublishingMetadata;
			return parsed?.version === 1 ? parsed : undefined;
		} catch { return undefined; }
	}

	async write(projectPath: string, value: ProjectPublishingMetadata): Promise<void> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await writeFile(await this.filePath(projectPath), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	}

	async list(): Promise<ProjectPublishingMetadata[]> {
		let names: string[];
		try { names = await readdir(this.root); } catch { return []; }
		const values = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
			try {
				const parsed = JSON.parse(await readFile(path.join(this.root, name), "utf8")) as ProjectPublishingMetadata;
				return parsed?.version === 1 ? parsed : undefined;
			} catch { return undefined; }
		}));
		return values.filter((value): value is ProjectPublishingMetadata => Boolean(value));
	}

	private async filePath(projectPath: string): Promise<string> {
		const canonical = await realpath(projectPath);
		const id = createHash("sha256").update(canonical).digest("hex");
		return path.join(this.root, `${id}.json`);
	}
}
