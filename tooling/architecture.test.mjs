import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkBoundaries } from "./check-boundaries.mjs";

const execFileAsync = promisify(execFile);

test("prohibited dependency directions are absent", async () => {
	assert.deepEqual(await checkBoundaries(), []);
});

test("release and internal package versions follow policy", async () => {
	await execFileAsync(process.execPath, ["tooling/check-versions.mjs"]);
});

test("facade and adapter packages expose deliberate public APIs", async () => {
	for (const name of ["sdk", "supabase-adapter", "contracts", "classroom", "organization", "education", "paseo-adapter", "policy", "publishing", "runtime", "sandbox", "sandbox-gondolin", "shared", "telemetry"]) {
		const manifest = JSON.parse(await readFile(path.resolve(`packages/${name}/package.json`), "utf8"));
		assert.ok(manifest.exports?.["."], `${name} must expose a package root`);
	}
});

test("student, teacher, organization and platform applications are separate dependency roots", async () => {
	const names = ["client", "teacher-console", "org-admin", "platform-admin"];
	const manifests = await Promise.all(names.map(async name => JSON.parse(await readFile(path.resolve(`apps/${name}/package.json`), "utf8"))));
	for (let index = 0; index < names.length; index++) {
		const manifest = manifests[index];
		assert.ok(manifest.scripts.build, `${names[index]} needs an independent build`);
		for (const other of names.filter(name => name !== names[index])) {
			assert.equal(manifest.dependencies?.[`@pi-student/${other}`], undefined, `${names[index]} must not depend on ${other}`);
		}
	}
});
