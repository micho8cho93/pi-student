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

it("uses Google OAuth without sending administrator sign-in emails", () => {
	const page = orgAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).toContain('id="google"');
	expect(page).toContain("signInWithOAuth({provider:'google'");
	expect(page).toContain("redirectTo:new URL('/auth/callback',location.href).toString()");
	expect(page).toContain("flowType:'pkce'");
	expect(page).toContain("exchangeCodeForSession(code)");
	expect(page).not.toContain("signInWithOtp");
	expect(page).not.toContain("verifyOtp");
	expect(page).not.toContain('id="email-form"');
});

it("offers sandbox site blocking, Skill and MCP review without exposing secret values", () => {
	const page = orgAdminPage({ url: "https://example.test", publishableKey: "public" });
	for (const tab of ["sandbox", "skills", "mcps"]) expect(page).toContain(`data-tab="${tab}"`);
	expect(page).not.toContain('data-tab="policies"');
	expect(page).toContain("save_organization_sandbox_blocked_sites");
	for (const rpc of ["save_organization_skill", "save_organization_mcp"]) expect(page).toContain(rpc);
	expect(page).toContain("Host-managed secret reference");
});

it("uses in-app forms for membership, classes, assignments, models, and prices", () => {
	const page = orgAdminPage({ url: "https://example.test", publishableKey: "public" });
	expect(page).not.toMatch(/\b(?:window\.)?prompt\s*\(/);
	expect(page).toContain("document.createElement('dialog')");
	for (const title of ["Add person", "Edit role", "Create class", "Manage teachers", "Edit model profile", "Set model price"]) {
		expect(page).toContain(title);
	}
	expect(page).toContain("error.textContent=cause.message||String(cause)");
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
