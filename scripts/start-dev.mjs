import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (existsSync(new URL("../apps/client/src/cli.ts", import.meta.url))) {
	const npm = process.env.npm_execpath ? process.env.npm_node_execpath ?? "node" : "npm";
	const args = process.env.npm_execpath ? [process.env.npm_execpath, "run", "build"] : ["run", "build"];
	const build = spawnSync(npm, args, { stdio: "inherit" });
	if (build.status !== 0) process.exit(build.status ?? 1);
}

process.env.PI_STUDENT_DEV = "1";
await import("../apps/client/dist/cli.js");
