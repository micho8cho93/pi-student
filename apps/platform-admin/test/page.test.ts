import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { platformAdminPage } from "../src/page.js";

it("checks the platform role and uses aggregate operations", () => {
	const page = platformAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain("is_platform_administrator");
	expect(page).toContain("platform_organization_summary");
	expect(page).not.toContain("from('sessions')");
	const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	expect(script).toBeDefined();
	expect(spawnSync(process.execPath, ["--check", "--input-type=module"], { input: script, encoding: "utf8" }).status).toBe(0);
});
