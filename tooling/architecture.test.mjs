import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

test("tests import only workspace packages their package depends on", async () => {
	// turbo builds only declared dependencies before a package's tests run, so an
	// undeclared import passes on a warm dist/ and fails on a clean CI runner.
	const manifests = new Map();
	for (const root of ["apps", "packages", "services"]) {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(root, entry.name);
			const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8").catch(() => "null"));
			if (manifest) manifests.set(manifest.name, { dir, deps: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }) });
		}
	}
	const closure = name => {
		const seen = new Set(), stack = [...manifests.get(name).deps];
		while (stack.length) {
			const next = stack.pop();
			if (seen.has(next) || !manifests.has(next)) continue;
			seen.add(next); stack.push(...manifests.get(next).deps);
		}
		return seen;
	};
	const problems = [];
	for (const [name, { dir }] of manifests) {
		const files = await readdir(path.join(dir, "test"), { recursive: true }).catch(() => []);
		const allowed = closure(name);
		for (const file of files.filter(file => /\.[cm]?[jt]sx?$/.test(file))) {
			const source = await readFile(path.join(dir, "test", file), "utf8");
			for (const [, imported] of source.matchAll(/from\s+["'](@pi-student\/[a-z0-9-]+)/g)) {
				if (imported !== name && manifests.has(imported) && !allowed.has(imported)) problems.push(`${dir}/test/${file} imports ${imported}`);
			}
		}
	}
	assert.deepEqual([...new Set(problems)], []);
});
