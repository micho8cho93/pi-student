import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { orgAdminPage } from "../src/page.js";
import { fakeAuth, FUTURE, PAST, runPage } from "../../../tooling/auth-page-harness.js";

it("embeds only escaped public client configuration", () => {
	const page = orgAdminPage({ url: "https://example.test/<script>", publishableKey: "public" });
	expect(page).not.toContain("https://example.test/<script>");
	expect(page).toContain("organization_has_entitlement");
	expect(page).toContain("set_organization_membership");
	expect(page).toContain("transfer_organization_ownership");
	expect(page).toContain("set_class_teacher_assignments");
	expect(page).not.toContain("assign_organization_teacher");
	expect(page).not.toContain("cdn.jsdelivr.net");
	const script = page.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
	expect(script).toBeDefined();
	expect(spawnSync(process.execPath, ["--check", "--input-type=module"], { input: script, encoding: "utf8" }).status).toBe(0);
});

it("uses Google OAuth without sending administrator sign-in emails", () => {
	const page = orgAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="google"');
	expect(page).toContain("lifecycle.beginSignIn(new URL('/auth/callback',location.href).toString())");
	expect(page).toContain("flowType:'pkce'");
	expect(page).toContain("exchangeCodeForSession(");
	expect(page).not.toContain("signInWithOtp");
	expect(page).not.toContain("verifyOtp");
	expect(page).not.toContain('id="email-form"');
});

it("offers sandbox site blocking and saved Skill and MCP approval checkboxes", () => {
	const page = orgAdminPage({ url: "https://example.test", publishableKey: "public" });
	for (const tab of ["sandbox", "skills", "mcps"]) expect(page).toContain(`data-tab="${tab}"`);
	expect(page).not.toContain('data-tab="policies"');
	expect(page).not.toContain('data-tab="environments"');
	expect(page).toContain("save_organization_sandbox_blocked_sites");
	for (const rpc of ["save_organization_skill", "save_organization_mcp"]) expect(page).toContain(rpc);
	expect(page).toContain('id="extension-approvals"');
	expect(page).toContain('data-catalog-id=');
	expect(page).toContain("Supabase MCP");
	expect(page).toContain("Impeccable");
	expect(page).toContain("approval_status");
	expect(page).toContain("allowed_hosts");
	expect(page).toContain("Requested capabilities");
	expect(page).not.toContain("select('*')");
	expect(page).not.toContain("secret_reference");
});

it("uses in-app forms for membership and classes, and provider checkboxes for models", () => {
	const page = orgAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).not.toMatch(/\b(?:window\.)?prompt\s*\(/);
	expect(page).toContain("document.createElement('dialog')");
	for (const title of ["Add person", "Edit role", "Create class", "Manage teachers", "Approved models", "Save providers"]) {
		expect(page).toContain(title);
	}
	expect(page).toContain("save_organization_providers");
	expect(page).toContain("save_model_profile");
	expect(page).toContain("model_profiles");
	expect(page).toContain('id="profile-available"');
	expect(page).toContain('data-provider-id=');
	expect(page).toContain("error.textContent=cause.message||String(cause)");
	expect(page).toContain("Ownership is transferred through its own workflow");
	expect(page).not.toContain("options:['owner','admin','teacher','member']");
});

it("shows organization-owned settings and stages deletion confirmation", () => {
	const page = orgAdminPage({ url: "https://example.test", publishableKey: "public" });
	for (const field of ["contact_email", "teachers_can_create_classes", "students_can_join_by_code"]) {
		expect(page).toContain(field);
	}
	expect(page).toContain("Signed in as");
	expect(page).not.toContain("Product capabilities</h2>");
	expect(page).toContain("org.role==='owner'?'<h2>Delete organization");
	expect(page).toContain("phraseForm.classList.add('hidden');finalForm.classList.remove('hidden')");
	expect(page).toContain("confirmButton.disabled=!checkbox.checked");
	expect(page).toContain("db.rpc('deactivate_organization'");
});

const account = { id: "u-1", email: "admin@example.test" };
const orgMembership = { organization_id: "org-1", role: "owner", status: "active", organizations: { id: "org-1", slug: "acme", name: "Acme", status: "active", contact_email: null, teachers_can_create_classes: true, students_can_join_by_code: true } };

describe("organization administration authentication states", () => {
	const page = () => orgAdminPage({ url: "https://example.test", publishableKey: "public" });
	const run = (behavior: Parameters<typeof fakeAuth>[0], href = "https://admin.test/", extra: { tables?: Record<string, unknown>; rpc?: Record<string, unknown> } = {}) => {
		const fake = fakeAuth(behavior);
		return { fake, started: runPage(page(), { href, auth: fake.auth, ...extra }) };
	};

	it("shows the sign-in card when logged out", async () => {
		const { started } = run({});
		const ui = await started;
		expect(ui.visible("auth")).toBe(true);
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.visible("signout")).toBe(false);
	});

	it("does not show the workspace until the backend confirms identity and access", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const { started } = run({ session: { expires_at: FUTURE, user: account }, getUser: async () => { await gate; return { data: { user: account }, error: null }; } },
			"https://admin.test/", { tables: { organization_memberships: [orgMembership] }, rpc: { organization_has_entitlement: true } });
		const ui = await started;
		// A local session exists but getUser is still pending: nothing authenticated may be shown.
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.visible("signout")).toBe(false);
		expect(ui.text("notice")).toContain("Checking");
		release();
		await ui.settle(30);
		expect(ui.visible("workspace")).toBe(true);
		expect(ui.visible("auth")).toBe(false);
		expect(ui.visible("signout")).toBe(true);
	});

	it("shows a callback state while the code exchange is in flight, then the workspace", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const { started, fake } = run({ exchange: async () => { await gate; return { data: {}, error: null }; } }, "https://admin.test/auth/callback?code=abc",
			{ tables: { organization_memberships: [orgMembership] }, rpc: { organization_has_entitlement: true } });
		const ui = await started;
		expect(ui.text("notice")).toContain("Completing Google sign-in");
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.disabled("google")).toBe(true);
		expect(ui.href()).not.toContain("code=");
		release();
		await ui.settle(30);
		expect(ui.visible("workspace")).toBe(true);
		expect(fake.state.exchanges).toEqual(["abc"]);
	});

	it("explains denied consent and stays logged out", async () => {
		const { started } = run({}, "https://admin.test/auth/callback?error=access_denied&error_description=User%20denied%20access");
		const ui = await started;
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.visible("auth")).toBe(true);
		expect(ui.text("notice")).toMatch(/cancelled|denied/i);
	});

	it("reports an expired session and hides the workspace", async () => {
		const { started, fake } = run({ session: { expires_at: PAST, user: account }, refresh: async () => ({ data: { session: null }, error: { message: "Invalid Refresh Token: Refresh Token Not Found" } }) });
		const ui = await started;
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.visible("auth")).toBe(true);
		expect(ui.text("notice")).toContain("session expired");
		expect(fake.state.session).toBeNull();
	});

	it("separates authenticated from authorized: no organization access", async () => {
		const { started } = run({ session: { expires_at: FUTURE, user: account } }, "https://admin.test/", { tables: { organization_memberships: [] } });
		const ui = await started;
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.visible("auth")).toBe(false);
		expect(ui.visible("signout")).toBe(true);
		expect(ui.text("notice")).toContain("no active organization administration access");
	});

	it("refuses an organization whose administration entitlement is disabled", async () => {
		const { started } = run({ session: { expires_at: FUTURE, user: account } }, "https://admin.test/", { tables: { organization_memberships: [orgMembership] }, rpc: { organization_has_entitlement: false } });
		const ui = await started;
		expect(ui.visible("workspace")).toBe(false);
		expect(ui.text("notice")).toContain("no active organization administration access");
	});

	it("starts Google sign-in from the button and stays busy while redirecting", async () => {
		const { started, fake } = run({});
		const ui = await started;
		await ui.click("google");
		expect(fake.state.signIns).toBe(1);
		expect(ui.disabled("google")).toBe(true);
	});
});
