import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const MARKER = "/* pi-student-learn-controls-v1 */";
/** Expose the controls' actual agent identity, including split panes; never guess from workspace alone. */
export function patchLearnControlsSource(source: string): string {
	if (source.includes(MARKER)) return source;
	const start = source.indexOf('Object.defineProperty(_e,"AgentControls",{enumerable:!0,get:function(){return xe}})');
	if (start < 0 || !source.includes('const xe=(0,s.memo)(function(e){')) throw new Error("Paseo's composer is incompatible with Learn Mode. Update the controls adapter before launching.");
	const patched = source.replace('Object.defineProperty(_e,"AgentControls",{enumerable:!0,get:function(){return xe}})',
		'PiStudentAgentControls=function(props){return(0,J.jsx)("div",{"data-pi-student-agent-id":props.agentId,"data-pi-student-server-id":props.serverId,style:{display:"contents"},children:(0,J.jsx)(xe,props)})},Object.defineProperty(_e,"AgentControls",{enumerable:!0,get:function(){return PiStudentAgentControls}})');
	const moduleStart = source.lastIndexOf("__d(", start);
	const bodyStart = source.indexOf('"use strict";', moduleStart) + '"use strict";'.length;
	if (moduleStart < 0 || bodyStart > start) throw new Error("Paseo's controls module could not be located.");
	const declaration = `${MARKER}var PiStudentAgentControls;`;
	return patched.slice(0, bodyStart) + declaration + patched.slice(bodyStart);
}

export async function patchLearnControlsBundle(indexPath: string): Promise<void> {
	const root = path.join(path.dirname(indexPath), "_expo", "static", "js", "web");
	let html = await readFile(indexPath, "utf8");
	let names: string[];
	try { names = await readdir(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	const active = names.filter(name => /^index-.*\.js$/.test(name) && html.includes(`/web/${name}`));
	if (!active.length) throw new Error("Paseo's active composer bundle could not be found.");
	for (const name of active) {
		const source = await readFile(path.join(root, name), "utf8");
		const patched = patchLearnControlsSource(source);
		if (source === patched) continue;
		const next = `index-pi-learn-${createHash("sha256").update(patched).digest("hex").slice(0, 20)}.js`;
		await writeFile(path.join(root, next), patched);
		html = html.replaceAll(`/web/${name}`, `/web/${next}`);
	}
	await writeFile(indexPath, html);
}
