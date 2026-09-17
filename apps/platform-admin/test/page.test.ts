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

it("uses Google OAuth without sending administrator sign-in emails", () => {
	const page = platformAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="google"');
	expect(page).toContain("signInWithOAuth({provider:'google'");
	expect(page).toContain("redirectTo:new URL('/auth/callback',location.href).toString()");
	expect(page).toContain("flowType:'pkce'");
	expect(page).toContain("exchangeCodeForSession(code)");
	expect(page).not.toContain("signInWithOtp");
	expect(page).not.toContain("verifyOtp");
	expect(page).not.toContain('id="email-form"');
});

it("collects organization details in an on-page form", () => {
	const page = platformAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="create-org-form"');
	expect(page).toContain('id="new-org-name"');
	expect(page).toContain('id="new-org-slug"');
	expect(page).toContain('id="new-org-owner"');
	expect(page).toContain('id="create-org-error"');
	expect(page).toContain("db.rpc('platform_create_organization'");
	expect(page).not.toContain("prompt('Organization slug");
});

it("adds administrators through an in-app form", () => {
	const page = platformAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).not.toMatch(/\b(?:window\.)?prompt\s*\(/);
	expect(page).toContain("document.createElement('dialog')");
	expect(page).toContain("title:'Add administrator'");
	expect(page).toContain("type:'email',required:true");
});
