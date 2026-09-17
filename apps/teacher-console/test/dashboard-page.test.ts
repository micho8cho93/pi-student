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
