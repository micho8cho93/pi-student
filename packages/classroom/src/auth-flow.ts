export type AuthCallback =
	| { kind: "code"; code: string }
	| { kind: "session"; accessToken: string; refreshToken: string }
	| { kind: "error"; message: string }
	| { kind: "none" };

/**
 * The callback is served by the local dashboard. Keeping this path stable
 * makes it possible to allow one redirect URL for both Google and email auth.
 */
export function teacherAuthCallbackUrl(origin: string): string {
	return new URL("/auth/callback", origin).toString();
}

export function readAuthCallback(urlString: string): AuthCallback {
	const url = new URL(urlString);
	const queryError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
	if (queryError) return { kind: "error", message: queryError };

	const code = url.searchParams.get("code");
	if (code) return { kind: "code", code };

	// Older Supabase projects may still use the implicit flow. Supporting its
	// fragment here makes an existing teacher session recoverable after the
	// callback hardening is deployed.
	const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
	const fragmentError = fragment.get("error_description") ?? fragment.get("error");
	if (fragmentError) return { kind: "error", message: fragmentError };
	const accessToken = fragment.get("access_token");
	const refreshToken = fragment.get("refresh_token");
	if (accessToken && refreshToken) return { kind: "session", accessToken, refreshToken };
	return { kind: "none" };
}

export function describeAuthError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if (normalized.includes("redirect") || normalized.includes("redirect_to")) {
		return `${message} Add the exact URL http://127.0.0.1:4173/auth/callback to Supabase Auth → URL Configuration → Redirect URLs.`;
	}
	if (normalized.includes("provider") && (normalized.includes("enable") || normalized.includes("support"))) {
		return `${message} Enable Google under Supabase Auth → Sign In / Providers → Google, then add the OAuth callback URL shown there in Google Cloud.`;
	}
	if (normalized.includes("rate") || normalized.includes("too many") || normalized.includes("email")) {
		return `${message} You can use an email OTP with “Verify code”, or wait for the email limit to reset. Custom SMTP raises the built-in provider's delivery limit.`;
	}
	return message;
}
