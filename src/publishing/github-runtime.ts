import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

const run = promisify(execFile);
const version = "2.100.0";
const checksums: Record<string, string> = {
	linux_amd64: "e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be",
	linux_arm64: "ea4e7a581a32ccad6cc7923cb1576ac5859ba4b9a16ab22eb8f8a96e78e2e961",
	macOS_amd64: "fcd7799e85eb575f3c7d2b1679bfbfedaefa1269d4bc7d096b51e10939b4812b",
	macOS_arm64: "45f9a62da2f6e641a7fad57e2ce39656dfd7ef331372d80a2a2aed65abb01642",
	windows_amd64: "227e35230b25db3fa1b997bab7cf4d67df0470a3b75b99e4ee66bce1a7cd4e72",
	windows_arm64: "7beaeb4743cf255809a8e574a2724c685b566545e04eabea284fe38a56c15b02",
};
let preparing: Promise<string> | undefined;

// Include this directory in the daemon PATH even before the first connection.
export function githubHelperDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	return path.join(env.PI_STUDENT_HOME?.trim() || path.join(homedir(), ".pi-student"), "tools", `gh-${version}-${platform}_${arch}`, "bin");
}

export async function githubExecutable(install = false): Promise<string> {
	try { await run("gh", ["--version"]); return "gh"; } catch { /* Use Pi's private helper. */ }
	const platform = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	const target = `${platform}_${arch}`;
	const root = path.dirname(githubHelperDirectory());
	const binary = path.join(root, "bin", process.platform === "win32" ? "gh.exe" : "gh");
	try { await access(binary); return binary; } catch { /* Install only on an explicit connect. */ }
	if (!install) throw new Error("Select Connect to sign in to GitHub in your browser.");
	if (!checksums[target]) throw new Error("Browser sign-in is not supported on this operating system yet.");
	if (!preparing) preparing = installHelper(root, binary, target).finally(() => { preparing = undefined; });
	return preparing;
}

async function installHelper(root: string, binary: string, target: string): Promise<string> {
	await mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
	const temporary = await mkdtemp(path.join(path.dirname(root), ".github-"));
	try {
		const extension = target.startsWith("linux") ? "tar.gz" : "zip";
		const name = `gh_${version}_${target}`;
		const response = await fetch(`https://github.com/cli/cli/releases/download/v${version}/${name}.${extension}`, { signal: AbortSignal.timeout(120_000) });
		if (!response.ok) throw new Error(`Download returned ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		verifyGitHubDownload(bytes, checksums[target]);
		const archive = path.join(temporary, `download.${extension}`);
		await writeFile(archive, bytes);
		if (process.platform === "darwin") await run("/usr/bin/ditto", ["-x", "-k", archive, temporary]);
		else await run("tar", ["-xf", archive, "-C", temporary]);
		const extracted = path.join(temporary, name);
		// Windows archives have bin/ at their root.
		let source = extracted;
		try { await access(path.join(source, "bin")); } catch { source = temporary; }
		const payload = await readFile(path.join(source, "bin", path.basename(binary)));
		await mkdir(path.join(temporary, "ready", "bin"), { recursive: true });
		const staged = path.join(temporary, "ready", "bin", path.basename(binary));
		await writeFile(staged, payload, { mode: 0o755 });
		await chmod(staged, 0o755);
		await run(staged, ["--version"]);
		try { await rename(path.join(temporary, "ready"), root); }
		catch (error) { try { await access(binary); } catch { throw error; } }
		return binary;
	} catch (error) {
		throw new Error(`Could not prepare GitHub sign-in. Check your internet connection and select Connect to retry. ${error instanceof Error ? error.message : ""}`);
	} finally { await rm(temporary, { recursive: true, force: true }); }
}

export function verifyGitHubDownload(bytes: Uint8Array, expected: string): void {
	if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error("GitHub helper checksum did not match.");
}

export interface GitHubSignInProgress { status: "preparing" | "waiting" | "connected" | "failed"; code?: string; url?: string; error?: string }

export function deviceCode(output: string): string | undefined {
	return output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i)?.[1];
}

export async function browserLogin(onProgress: (progress: GitHubSignInProgress) => void): Promise<void> {
	onProgress({ status: "preparing" });
	const binary = await githubExecutable(true);
	await new Promise<void>((resolve, reject) => {
		let output = "";
		let shown = false;
		const child = execFile(binary, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--scopes", "public_repo,workflow"],
			{ timeout: 16 * 60_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
			(error) => error ? reject(new Error("GitHub sign-in expired or was cancelled. Select Connect to try again.")) : resolve());
		const receive = (chunk: Buffer) => {
			output = (output + chunk.toString()).slice(-8000);
			const code = deviceCode(output);
			if (code && !shown) {
				shown = true;
				onProgress({ status: "waiting", code, url: "https://github.com/login/device" });
			}
		};
		child.stdout?.on("data", receive);
		child.stderr?.on("data", receive);
		child.stdin?.end("\n");
	});
}
