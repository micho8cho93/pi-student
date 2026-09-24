import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const MARKER = "/* pi-student-learn-controls-v1 */";
const SESSION_CLOSE_MARKER = "/* pi-student-session-close-only-v1 */";
/** Keep tab close layout-only and expose the controls' actual agent identity, including split panes. */
export function patchLearnControlsSource(source: string): string {
	let patched = source;
	if (!patched.includes(SESSION_CLOSE_MARKER)) {
		const policy = 'e.resolveCloseAgentTabPolicy=function(n){if(n?.parentAgentId)return{kind:"layout-only"};return{kind:"archive-on-close"}}';
		if (!patched.includes(policy)) throw new Error("Paseo's session close policy is incompatible with Pi Student. Update the session adapter before launching.");
		patched = patched.replace(policy, `${SESSION_CLOSE_MARKER}e.resolveCloseAgentTabPolicy=function(){return{kind:"layout-only"}}`);
	}
	if (patched.includes(MARKER)) return patched;
	const start = patched.indexOf('Object.defineProperty(_e,"AgentControls",{enumerable:!0,get:function(){return xe}})');
	if (start < 0 || !patched.includes('const xe=(0,s.memo)(function(e){')) throw new Error("Paseo's composer is incompatible with Learn Mode. Update the controls adapter before launching.");
	patched = patched.replace('Object.defineProperty(_e,"AgentControls",{enumerable:!0,get:function(){return xe}})',
		'PiStudentAgentControls=function(props){return(0,J.jsx)("div",{"data-pi-student-agent-id":props.agentId,"data-pi-student-server-id":props.serverId,style:{display:"contents"},children:(0,J.jsx)(xe,props)})},Object.defineProperty(_e,"AgentControls",{enumerable:!0,get:function(){return PiStudentAgentControls}})');
	const moduleStart = patched.lastIndexOf("__d(", start);
	const bodyStart = patched.indexOf('"use strict";', moduleStart) + '"use strict";'.length;
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
