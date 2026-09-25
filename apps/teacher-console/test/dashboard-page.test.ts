import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { dashboardPage } from "../src/dashboard-page.js";
import { fakeAuth, FUTURE, PAST, runPage } from "../../../tooling/auth-page-harness.js";

it("uses Google OAuth as the only teacher dashboard sign-in method", () => {
	const page = dashboardPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="google"');
	expect(page).toContain("lifecycle.beginSignIn(authCallback())");
	expect(page).toContain("exchangeCodeForSession(");
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
	for (const area of ["classes", "students", "models", "skills", "mcps", "usage"]) {
		expect(page).toContain(`id="side-${area}"`);
		if (area !== "classes") expect(page).toContain(`id="${area}-view"`);
	}
	expect(page).toContain("teacher_extension_catalog");
	expect(page).toContain("set_teacher_extension_enabled");
	expect(page).toContain("Save selections");
	expect(page).toContain("approved_provider_ids");
	expect(page).toContain("teacher_usage_summary");
	expect(page).toContain("save_governance_policy");
});

describe("teacher dashboard authentication states", () => {
	const teacher = { id: "t-1", email: "teacher@example.test" };
	const run = (behavior: Parameters<typeof fakeAuth>[0], href = "https://teacher.test/") => {
		const fake = fakeAuth(behavior);
		return { fake, started: runPage(dashboardPage({ url: "https://example.test", publishableKey: "public" }), { href, auth: fake.auth }) };
	};

	it("shows sign-in when logged out", async () => {
		const ui = await run({}).started;
		expect(ui.visible("auth")).toBe(true);
		expect(ui.visible("app")).toBe(false);
		expect(ui.visible("signout")).toBe(false);
	});

	it("does not show the app while the backend confirmation is pending", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const { started } = run({ session: { expires_at: FUTURE, user: teacher }, getUser: async () => { await gate; return { data: { user: teacher }, error: null }; } });
		const ui = await started;
		expect(ui.visible("app")).toBe(false);
		expect(ui.text("user-email")).toBe("");
		release();
		await ui.settle(30);
		expect(ui.visible("app")).toBe(true);
		expect(ui.text("user-email")).toBe("teacher@example.test");
	});

	it("shows the callback state, strips the code and completes", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const { started, fake } = run({ exchange: async () => { await gate; return { data: {}, error: null }; } }, "https://teacher.test/auth/callback?code=abc");
		const ui = await started;
		expect(ui.text("auth-note")).toContain("Completing Google sign-in");
		expect(ui.visible("app")).toBe(false);
		expect(ui.href()).not.toContain("code=");
		release();
		await ui.settle(30);
		expect(ui.visible("app")).toBe(true);
		expect(fake.state.exchanges).toEqual(["abc"]);
	});

	it("keeps a class deep link when stripping the callback", async () => {
		const ui = await run({}, "https://teacher.test/auth/callback?code=abc&class=class-9").started;
		expect(ui.href()).toBe("https://teacher.test/?class=class-9");
	});

	it("explains denied consent and an expired session", async () => {
		const denied = await run({}, "https://teacher.test/auth/callback?error=access_denied&error_description=denied").started;
		expect(denied.visible("app")).toBe(false);
		expect(denied.text("auth-note")).toMatch(/denied/i);
		const expired = await run({ session: { expires_at: PAST, user: teacher }, refresh: async () => ({ data: { session: null }, error: { message: "refresh_token_not_found" } }) }).started;
		expect(expired.visible("app")).toBe(false);
		expect(expired.text("auth-note")).toContain("session expired");
	});
});
