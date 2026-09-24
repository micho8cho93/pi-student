import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dashboardPage } from "../src/dashboard-page.js";

it("uses Google OAuth as the only teacher dashboard sign-in method", () => {
	const page = dashboardPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="google"');
	expect(page).toContain("signInWithOAuth({provider:'google'");
	expect(page).toContain("redirectTo:authCallback()");
	expect(page).toContain("exchangeCodeForSession(code)");
	expect(page).not.toContain("signInWithOtp");
	expect(page).not.toContain("verifyOtp");
	expect(page).not.toContain('id="email"');
	expect(page).not.toContain('id="magic"');
	expect(page).not.toContain('id="otp"');
	const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	expect(script).toBeDefined();
	expect(spawnSync(process.execPath, ["--check", "--input-type=module"], { input: script, encoding: "utf8" }).status).toBe(0);
});

it("renders account, class, and display settings with two deletion confirmations", () => {
	const page = dashboardPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="side-settings"');
	expect(page).toContain('id="settings-view"');
	expect(page).toContain('id="profile-form"');
	expect(page).toContain('id="preferences-form"');
	expect(page).toContain('id="settings-classes"');
	expect(page).toContain('id="delete-account-step-one"');
	expect(page).toContain('id="delete-account-step-two"');
	expect(page).not.toContain("prepare_teacher_account_deletion");
	expect(page).toContain("fetch('/api/account/delete'");
});

it("offers teacher class, student, extension, and usage controls", () => {
	const page = dashboardPage({ url: "https://example.test", publishableKey: "public" });
	for (const area of ["classes", "students", "skills", "mcps", "usage"]) {
		expect(page).toContain(`id="side-${area}"`);
		if (area !== "classes") expect(page).toContain(`id="${area}-view"`);
	}
	expect(page).toContain("teacher_extension_catalog");
	expect(page).toContain("set_teacher_extension_enabled");
	expect(page).toContain("teacher_usage_summary");
	expect(page).toContain("save_governance_policy");
});
