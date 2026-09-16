import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { orgAdminPage } from "../src/page.js";

it("embeds only escaped public client configuration", () => {
	const page = orgAdminPage({ url: "https://example.test/<script>", publishableKey: "public" });
	expect(page).not.toContain("https://example.test/<script>");
	expect(page).toContain("organization_has_entitlement");
	expect(page).toContain("set_organization_membership");
	const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	expect(script).toBeDefined();
	expect(spawnSync(process.execPath, ["--check", "--input-type=module"], { input: script, encoding: "utf8" }).status).toBe(0);
});
