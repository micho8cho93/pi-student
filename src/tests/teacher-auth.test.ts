import { describe, expect, it } from "vitest";
import { describeAuthError, readAuthCallback, teacherAuthCallbackUrl } from "../teacher/auth-flow.js";
import { readSupabaseConfig } from "../teacher/config.js";

describe("teacher authentication flow", () => {
	it("uses one explicit callback path for local browser auth", () => {
		expect(teacherAuthCallbackUrl("http://127.0.0.1:4173")).toBe("http://127.0.0.1:4173/auth/callback");
	});

	it("allows only localhost HTTP for local Supabase development", () => {
		expect(readSupabaseConfig({ PI_STUDENT_SUPABASE_URL: "http://127.0.0.1:54321", PI_STUDENT_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" })).toEqual({ url: "http://127.0.0.1:54321", publishableKey: "sb_publishable_test" });
		expect(() => readSupabaseConfig({ PI_STUDENT_SUPABASE_URL: "http://example.test", PI_STUDENT_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" })).toThrow(/HTTPS/);
	});

	it("reads PKCE, implicit, and provider-error callback forms", () => {
		expect(readAuthCallback("http://127.0.0.1:4173/auth/callback?code=abc")).toEqual({ kind: "code", code: "abc" });
		expect(readAuthCallback("http://127.0.0.1:4173/auth/callback#access_token=access&refresh_token=refresh")).toEqual({ kind: "session", accessToken: "access", refreshToken: "refresh" });
		expect(readAuthCallback("http://127.0.0.1:4173/auth/callback?error=access_denied&error_description=Google%20cancelled")).toEqual({ kind: "error", message: "Google cancelled" });
	});

	it("turns common Supabase auth failures into actionable guidance", () => {
		expect(describeAuthError(new Error("provider is not enabled"))).toContain("Enable Google");
		expect(describeAuthError(new Error("redirect_to is not allowed"))).toContain("/auth/callback");
		expect(describeAuthError(new Error("over_email_send_rate_limit"))).toContain("Verify code");
	});
});
