import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const importPattern = /(?:from\s+|import\s*\(|require\s*\()\s*["']([^"']+)["']/g;

const rules = [
	{ areas: ["packages"], test: value => ["@pi-student/client", "@pi-student/teacher-console", "@pi-student/org-admin", "@pi-student/platform-admin"].some(name => value.startsWith(name)) || value.includes("/apps/"), reason: "packages must not depend on applications" },
	{ areas: ["packages/contracts"], test: value => value.startsWith("@pi-student/"), reason: "contracts must not depend on Pi Student packages" },
	{ areas: ["packages/runtime"], test: value => ["@pi-student/paseo-adapter", "@pi-student/teacher-console", "@pi-student/sandbox-gondolin", "@pi-student/supabase-adapter"].some(name => value.startsWith(name)) || value.startsWith("@supabase/"), reason: "runtime must consume providers, not concrete adapters or applications" },
	{ areas: ["packages/runtime"], test: value => value.startsWith("@pi-student/organization") || value.startsWith("@pi-student/sdk/organization") || value.startsWith("@pi-student/org-admin") || value.startsWith("@pi-student/platform-admin"), reason: "runtime must not perform organization administration" },
	{ areas: ["packages/sandbox"], test: value => value.startsWith("@earendil-works/gondolin") || value.startsWith("@pi-student/sandbox-gondolin"), reason: "sandbox contracts must not depend on Gondolin" },
	{ areas: ["packages/education", "packages/policy", "packages/classroom", "packages/organization"], test: value => value.startsWith("@supabase/") || value.startsWith("@pi-student/supabase-adapter") || value.startsWith("supabase"), reason: "domain packages must not depend on Supabase" },
	{ areas: ["packages/organization"], test: value => value.startsWith("@pi-student/runtime") || value.startsWith("@pi-student/sdk"), reason: "organization domain must not depend on runtime or SDK" },
	{ areas: ["apps/client"], test: value => value.startsWith("@pi-student/organization") || value.startsWith("@pi-student/sdk/organization") || value.includes("org-admin") || value.includes("platform-admin") || value.includes("organization-authorization"), reason: "student client must not depend on administration" },
	{ areas: ["apps/teacher-console"], test: value => value.startsWith("@pi-student/org-admin") || value.startsWith("@pi-student/platform-admin"), reason: "teacher console must not depend on administration applications" },
	{ areas: ["apps/org-admin"], test: value => value.startsWith("@pi-student/platform-admin") || value.startsWith("@pi-student/client") || value.startsWith("@pi-student/teacher-console"), reason: "organization administration is an independent application" },
	{ areas: ["apps/platform-admin"], test: value => value.startsWith("@pi-student/org-admin") || value.startsWith("@pi-student/client") || value.startsWith("@pi-student/teacher-console"), reason: "platform administration is an independent application" },
	{ areas: ["packages/runtime"], test: value => value.startsWith("@getpaseo/") || value.startsWith("@pi-student/paseo-adapter"), reason: "runtime must not depend on Paseo" },
	{ areas: ["packages/classroom"], test: value => value.startsWith("@pi-student/teacher-console"), reason: "classroom domain must not depend on teacher presentation" },
	{ areas: ["apps", "packages"], test: value => /@pi-student\/[^/]+\/src\//.test(value), reason: "consumers must use package exports, not source internals" },
];

export async function checkBoundaries() {
	const files = await sourceFiles(root);
	const violations = [];
	for (const file of files) {
		const relative = path.relative(root, file).split(path.sep).join("/");
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(importPattern)) {
			const specifier = match[1];
			for (const rule of rules) {
				if (rule.areas.some(area => relative.startsWith(`${area}/`)) && rule.test(specifier)) violations.push(`${relative}: ${specifier} — ${rule.reason}`);
			}
		}
	}
	return violations;
}

async function sourceFiles(directory) {
	const result = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (["node_modules", "dist", ".git", ".turbo"].includes(entry.name)) continue;
		const target = path.join(directory, entry.name);
		if (entry.isDirectory()) result.push(...await sourceFiles(target));
		else if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) result.push(target);
	}
	return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const violations = await checkBoundaries();
	if (violations.length) { console.error(`Architecture boundary violations:\n${violations.map(item => `- ${item}`).join("\n")}`); process.exitCode = 1; }
	else console.log("Architecture boundaries: OK");
}
