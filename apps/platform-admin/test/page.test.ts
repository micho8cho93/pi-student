import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { platformAdminPage } from "../src/page.js";
import { fakeAuth, FUTURE, PAST, runPage } from "../../../tooling/auth-page-harness.js";

it("checks the platform role and uses aggregate operations", () => {
	const page = platformAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain("is_platform_administrator");
	expect(page).toContain("platform_organization_summary");
	expect(page).not.toContain("from('sessions')");
	expect(page).toContain("import {createClient} from '/supabase-browser.js'");
	expect(page).not.toContain("cdn.jsdelivr.net");
	const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	expect(script).toBeDefined();
	expect(spawnSync(process.execPath, ["--check", "--input-type=module"], { input: script, encoding: "utf8" }).status).toBe(0);
});

it("uses Google OAuth without sending administrator sign-in emails", () => {
	const page = platformAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="google"');
	expect(page).toContain("lifecycle.beginSignIn(new URL('/auth/callback',location.href).toString())");
	expect(page).toContain("flowType:'pkce'");
	expect(page).toContain("exchangeCodeForSession(");
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

it("shows owner-deactivated organizations as deleted and read only", () => {
	const page = platformAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain("status,deactivated_at,created_at");
	expect(page).toContain("o.deactivated_at?'Deleted':o.status");
	expect(page).toContain("if(selected.deactivated_at)");
	expect(page).toContain("input.disabled=true");
});

const operator = { id: "op-1", email: "operator@example.test" };

describe("platform administration authentication states", () => {
	const run = (behavior: Parameters<typeof fakeAuth>[0], href = "https://platform.test/", rpc: Record<string, unknown> = {}) => {
		const fake = fakeAuth(behavior);
		return { fake, started: runPage(platformAdminPage({ url: "https://example.test", publishableKey: "public" }), { href, auth: fake.auth, rpc }) };
	};

	it("shows sign-in when logged out", async () => {
		const ui = await run({}).started;
		expect(ui.visible("auth")).toBe(true);
		expect(ui.visible("workspace")).toBe(false);
	});

	it("keeps the workspace hidden until the backend confirms the user", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const { started } = run({
			session: { expires_at: FUTURE, user: operator },
			getUser: async () => { await gate; return { data: { user: operator }, error: null }; },
		}, "https://platform.test/", { is_platform_administrator: true });
		const ui = await started;
		// A local session exists but the backend has not confirmed it yet.
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.visible("signout")).toBe(false);
		expect(ui.text("notice")).toContain("Checking");
		release();
		await ui.settle(30);
		expect(ui.visible("workspace")).toBe(true);
		expect(ui.visible("auth")).toBe(false);
	});

	it("shows the callback state during the exchange and never leaves the code in the URL", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const { started, fake } = run({ exchange: async () => { await gate; return { data: {}, error: null }; } }, "https://platform.test/auth/callback?code=abc", { is_platform_administrator: true });
		const ui = await started;
		expect(ui.text("notice")).toContain("Completing Google sign-in");
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.href()).not.toContain("code=");
		release();
		await ui.settle(30);
		expect(ui.visible("workspace")).toBe(true);
		expect(fake.state.exchanges).toEqual(["abc"]);
	});

	it("reports denied consent, an invalid code and a missing verifier without opening the workspace", async () => {
		for (const [href, exchange, expected] of [
			["https://platform.test/auth/callback?error=access_denied&error_description=denied", undefined, /denied/i],
			["https://platform.test/auth/callback?code=x", async () => ({ data: {}, error: { message: "flow state not found" } }), /not valid/i],
			["https://platform.test/auth/callback?code=x", async () => ({ data: {}, error: { message: "PKCE code verifier not found in storage." } }), /same browser/i],
		] as const) {
			const ui = await run({ exchange }, href).started;
			expect(ui.visible("workspace")).toBe(false);
			expect(ui.visible("auth")).toBe(true);
			expect(ui.text("notice")).toMatch(expected);
		}
	});

	it("reports an expired session", async () => {
		const ui = await run({ session: { expires_at: PAST, user: operator }, refresh: async () => ({ data: { session: null }, error: { message: "refresh_token_not_found" } }) }).started;
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.text("notice")).toContain("session expired");
	});

	it("keeps an authenticated non-operator out of the workspace", async () => {
		const ui = await run({ session: { expires_at: FUTURE, user: operator } }, "https://platform.test/", { is_platform_administrator: false }).started;
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.visible("auth")).toBe(false);
		expect(ui.visible("signout")).toBe(true);
		expect(ui.text("notice")).toContain("not a platform operator");
	});
});
