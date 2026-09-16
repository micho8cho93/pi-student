import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [kind, artifactArgument] = process.argv.slice(2);
assert.ok(["client", "teacher"].includes(kind), "usage: verify-release-artifact.mjs <client|teacher> <archive>");
assert.ok(artifactArgument, "archive path is required");
const artifact = path.resolve(artifactArgument);
const entries = execFileSync("tar", ["-tzf", artifact], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	.split("\n")
	.filter(Boolean)
	.map(entry => entry.replace(/^\.\//, ""));

const has = prefix => entries.some(entry => entry === prefix || entry.startsWith(`${prefix}/`));
const forbidden = ["infra", "services", "supabase", "apps/org-admin", "apps/platform-admin", ".github", "tooling"];
for (const prefix of forbidden) assert.equal(has(prefix), false, `${kind} artifact must not contain ${prefix}`);

if (kind === "client") {
	for (const required of [
		"apps/client/dist/cli.js",
		"apps/client/dist/runtime-cli.js",
		"packages/sdk/dist/index.js",
		"packages/sandbox-gondolin/dist/index.js",
		"packages/paseo-adapter/dist/index.js",
	]) assert.equal(has(required), true, `client artifact is missing ${required}`);
	assert.equal(has("apps/teacher-console/dist/commands.js"), true, "client artifact must preserve the local teacher compatibility command");
} else {
	assert.equal(has("apps/teacher-console/dist/cli.js"), true, "teacher artifact is missing its CLI entrypoint");
	assert.equal(has("apps/client"), false, "teacher artifact must not contain the student client");
	assert.equal(has("packages/paseo-adapter"), false, "teacher artifact must not contain Paseo");
	assert.equal(has("packages/sandbox-gondolin"), false, "teacher artifact must not contain Gondolin");
}

process.stdout.write(`${kind} artifact boundary: OK (${entries.length} entries)\n`);
