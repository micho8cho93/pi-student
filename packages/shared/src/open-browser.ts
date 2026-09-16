import { execFile } from "node:child_process";
import process from "node:process";

export function openBrowser(url: string): void {
	const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	const child = execFile(command, args, { windowsHide: true });
	child.unref();
}
