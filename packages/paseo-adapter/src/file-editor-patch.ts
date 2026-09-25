import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MARKER = "/* pi-student-file-completion-v2 */";
const MOUNT = "return L.current=f,j.current({line:1,column:1}),()=>{f.destroy(),L.current=null}";
const HOOK = `${MARKER}const cleanup=globalThis.piStudentFileEditor?.(f,t.model.getSnapshot().version?.path||x);return L.current=f,j.current({line:1,column:1}),()=>{cleanup?.(),f.destroy(),L.current=null}`;

/** Expose only the mounted CodeMirror view. Paseo still owns editing and saving. */
export function patchFileEditorSource(source: string): string {
	if (source.includes(MARKER)) return source;
	const oldHook = "/* pi-student-file-completion-v1 */const cleanup=globalThis.piStudentFileEditor?.(f,x);return L.current=f,j.current({line:1,column:1}),()=>{cleanup?.(),f.destroy(),L.current=null}";
	if (source.includes(oldHook)) return source.replace(oldHook, HOOK);
	if (!source.includes('data-testid":"file-source-editor"') || !source.includes(MOUNT)) {
		throw new Error("Paseo's file editor is incompatible with Pi Student completions. Update the editor adapter before launching.");
	}
	return source.replace(MOUNT, HOOK);
}

export async function patchFileEditorBundle(indexPath: string): Promise<void> {
	const root = path.join(path.dirname(indexPath), "_expo", "static", "js", "web");
	let html = await readFile(indexPath, "utf8");
	let names: string[];
	try { names = await readdir(root); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	const active = names.filter(name => /^index-.*\.js$/.test(name) && html.includes(`/web/${name}`));
	if (!active.length) throw new Error("Paseo's active file editor bundle could not be found.");
	for (const name of active) {
		const source = await readFile(path.join(root, name), "utf8");
		const patched = patchFileEditorSource(source);
		if (source === patched) continue;
		const next = `index-pi-editor-${createHash("sha256").update(patched).digest("hex").slice(0, 20)}.js`;
		await writeFile(path.join(root, next), patched);
		html = html.replaceAll(`/web/${name}`, `/web/${next}`);
	}
	await writeFile(indexPath, html);
}
