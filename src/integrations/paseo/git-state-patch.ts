import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const MARKER = "// pi-student: discover repositories initialized after workspace creation v1";

// Paseo 0.8 caches non-Git snapshots forever, and its file observer excludes .git.
// Keep this compatibility fix in our launcher so npm reinstalls retain the fix.
export function patchGitStateSource(source: string): string {
	if (source.includes(MARKER)) return source;
	const replacements = [
		[
			"if (!request.force && target.latestSnapshot) {",
			"if (!request.force && target.latestSnapshot?.git.isGit) {",
		],
		[
			"                this.scheduleWorkspaceObservationSetup(target);\n            };\n            target.observationReensureTimer",
			`                if (target.latestFacts?.isGit === false) {
                    this.scheduleWorkspaceRefresh(target, {
                        scope: "structure", reason: "pi-student-repository-discovery", includeForge: false,
                    });
                }
                this.scheduleWorkspaceObservationSetup(target);
            };
            target.observationReensureTimer`,
		],
		[
			"        const facts = await this.loadCheckoutFacts(target, baseContext);",
			"        const wasGit = target.latestFacts?.isGit === true;\n        const facts = await this.loadCheckoutFacts(target, baseContext);",
		],
		[
			"        const context = { ...baseContext, facts };",
			`        if (!wasGit && facts.isGit) {
            target.observationSetupComplete = false;
            this.scheduleWorkspaceObservationSetup(target);
        }
        const context = { ...baseContext, facts };`,
		],
	];
	let patched = source;
	for (const [before, after] of replacements) {
		if (patched.split(before!).length !== 2) {
			throw new Error("The installed Paseo Git service is incompatible with Pi Student's repository detection fix.");
		}
		patched = patched.replace(before!, after!);
	}
	return `${MARKER}\n${patched}`;
}

export async function patchPaseoGitState(paseoExecutable: string): Promise<boolean> {
	const servicePath = path.resolve(path.dirname(paseoExecutable), "..", "@getpaseo", "server", "dist", "server", "server", "workspace-git-service.js");
	let source: string;
	try { source = await readFile(servicePath, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	const serverRoot = path.resolve(path.dirname(servicePath), "..");
	const gitPath = path.join(serverRoot, "utils", "checkout-git.js");
	const gitSource = await readFile(gitPath, "utf8");
	const bundleRoot = path.join(serverRoot, "web-ui", "_expo", "static", "js", "web");
	const indexPath = path.join(serverRoot, "web-ui", "index.html");
	const indexHtml = await readFile(indexPath, "utf8");
	let patchedIndex = indexHtml;
	const bundles = (await readdir(bundleRoot)).filter(name => /^index-.*\.js$/.test(name) && indexHtml.includes(`/web/${name}`));
	if (!bundles.length) throw new Error("Paseo web UI has no supported application bundle.");
	const updates = [{ file: servicePath, original: source, patched: patchGitStateSource(source) },
		{ file: gitPath, original: gitSource, patched: patchCommitHistorySource(gitSource) }];
	for (const name of bundles) {
		const file = path.join(bundleRoot, name);
		const original = await readFile(file, "utf8");
		const patched = patchCommitsUiSource(original);
		// Assets are cached immutably. A new filename is required for existing browsers.
		const newName = `index-pi-${createHash("sha256").update(patched).digest("hex").slice(0, 20)}.js`;
		const newFile = path.join(bundleRoot, newName);
		let existing = "";
		try { existing = await readFile(newFile, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		updates.push({ file: newFile, original: existing, patched });
		patchedIndex = patchedIndex.replaceAll(`/web/${name}`, `/web/${newName}`);
	}
	updates.push({ file: indexPath, original: indexHtml, patched: patchedIndex });
	let changed = false;
	for (const update of updates) {
		if (update.original === update.patched) continue;
		await writeFile(update.file, update.patched);
		changed = true;
	}
	return changed;
}

export function patchCommitHistorySource(source: string): string {
	const marker = "// pi-student: include complete local commit history";
	if (source.includes(marker)) return source;
	const before = "            maxCount: CHECKOUT_BASE_COMMIT_LIMIT,";
	if (source.split(before).length !== 2) throw new Error("Unsupported Paseo commit history implementation.");
	return marker + "\n" + source.replace(before, "");
}

export function patchCommitsUiSource(source: string): string {
	const marker = "/* pi-student: show published commits */";
	if (source.includes(marker)) return source;
	const lines = source.split("\n");
	const index = lines.findIndex(line => line.includes(".CommitsSection=function"));
	if (index < 0) throw new Error("Unsupported Paseo commits panel implementation.");
	const pattern = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return!\2.isOnBase\}/g;
	if ([...lines[index]!.matchAll(pattern)].length !== 2) throw new Error("Unsupported Paseo commit filters.");
	lines[index] = lines[index]!.replace(pattern, "function $1($2){return true}");
	// The existing translations describe only commits ahead of the base branch.
	return marker + "\n" + lines.join("\n")
		.replace('noneAhead:"No commits ahead of {{baseRef}} yet"', 'noneAhead:"No commits yet"')
		.replace(/countLabel:"[^"\n]*workspace commits[^"\n]*"/, 'countLabel:"{{count}} commits"');
}
