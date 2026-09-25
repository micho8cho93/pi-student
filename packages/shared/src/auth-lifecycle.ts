/**
 * Authentication lifecycle shared by the terminal sign-in, the teacher
 * dashboard and both administration pages.
 *
 * `createAuthLifecycle` is deliberately self-contained (no imports, no module
 * scope references) so the exact same function can be embedded into the
 * browser pages with `authLifecycleScript` and still be unit-tested in Node.
 *
 * Invariant: `authenticated` is only ever reported after the auth backend has
 * validated the user (`getUser`) and the caller-supplied `authorize` check has
 * passed. Sessions read from local storage are never trusted on their own.
 */

export type AuthStatus =
	| "logged_out"
	| "authenticating"
	| "callback"
	| "authenticated"
	| "expired"
	| "denied"
	| "unauthorized";

export type AuthFailureReason =
	| "consent_denied"
	| "invalid_code"
	| "expired_code"
	| "missing_verifier"
	| "timeout"
	| "session_expired"
	| "redirect_config"
	| "provider_disabled"
	| "authorization_check_failed"
	| "unknown";

export interface AuthUser { id: string; email?: string | null }
export interface AuthSnapshot { status: AuthStatus; user?: AuthUser; message?: string; reason?: AuthFailureReason }
export interface AuthorizationResult { ok: boolean; message?: string }

type Result<T> = Promise<{ data: T; error: { message?: string; code?: string; name?: string } | null }>;
export interface AuthClientLike {
	auth: {
		getSession(): Result<{ session: { expires_at?: number | null; user?: AuthUser } | null }>;
		getUser(): Result<{ user: AuthUser | null }>;
		refreshSession(): Result<{ session: { expires_at?: number | null; user?: AuthUser } | null }>;
		exchangeCodeForSession(code: string): Result<unknown>;
		setSession(tokens: { access_token: string; refresh_token: string }): Result<unknown>;
		signInWithOAuth(input: { provider: "google"; options: { redirectTo: string; skipBrowserRedirect?: boolean } }): Result<{ url?: string | null }>;
		signOut(options?: { scope?: "local" | "global" | "others" }): Promise<{ error: { message?: string } | null }>;
	};
}

export interface AuthLifecycleOptions {
	client: AuthClientLike;
	/** Runs only after the backend has confirmed the identity. */
	authorize?: (user: AuthUser) => Promise<AuthorizationResult>;
	timeoutMs?: number;
	/** Epoch milliseconds; injectable for tests. */
	now?: () => number;
	onChange?: (snapshot: AuthSnapshot) => void;
}

export interface AuthLifecycle {
	readonly snapshot: AuthSnapshot;
	/** Handles an OAuth redirect URL. Returns `undefined` when the URL is not an auth callback. */
	handleCallback(url: string): Promise<AuthSnapshot | undefined>;
	/** Confirms the current identity with the backend and runs `authorize`. */
	resolve(): Promise<AuthSnapshot>;
	beginSignIn(redirectTo: string, skipBrowserRedirect?: boolean): Promise<{ url?: string; snapshot: AuthSnapshot }>;
	signOut(): Promise<AuthSnapshot>;
}

export function createAuthLifecycle(options: AuthLifecycleOptions): AuthLifecycle {
	const client = options.client;
	const timeoutMs = options.timeoutMs ?? 15000;
	const now = options.now ?? (() => Date.now());
	const MESSAGES: Record<string, string> = {
		consent_denied: "Google sign-in was cancelled or access was denied.",
		invalid_code: "This sign-in link is not valid. Start sign-in again.",
		expired_code: "This sign-in link expired. Start sign-in again.",
		missing_verifier: "This sign-in could not be completed in this browser. Start again from this page in the same browser.",
		timeout: "Sign-in timed out. Try again.",
		session_expired: "Your session expired. Sign in again.",
	};
	let snapshot: AuthSnapshot = { status: "logged_out" };
	const inflight = new Map<string, Promise<AuthSnapshot | undefined>>();
	// key -> failure snapshot to replay for a repeated delivery, or null once the callback succeeded.
	const settled = new Map<string, AuthSnapshot | null>();
	let resolving: Promise<AuthSnapshot> | undefined;

	function set(next: AuthSnapshot): AuthSnapshot {
		snapshot = next;
		if (options.onChange) options.onChange(next);
		return next;
	}

	function classify(error: unknown, context: "callback" | "session" | "start"): { reason: AuthFailureReason; message: string } {
		const source = (error && typeof error === "object" ? error : {}) as { message?: unknown; code?: unknown; name?: unknown; error?: unknown };
		const raw = typeof error === "string" ? error : typeof source.message === "string" ? source.message : "";
		const text = `${typeof source.code === "string" ? source.code : ""} ${typeof source.name === "string" ? source.name : ""} ${raw}`.toLowerCase();
		let reason: AuthFailureReason = "unknown";
		if (source.name === "AuthTimeoutError" || text.includes("timed out") || text.includes("timeout")) reason = "timeout";
		else if (text.includes("access_denied") || text.includes("denied") || text.includes("cancel")) reason = "consent_denied";
		else if (text.includes("code verifier") || text.includes("bad_code_verifier") || text.includes("code challenge")) reason = "missing_verifier";
		else if (context === "start" && (text.includes("redirect"))) reason = "redirect_config";
		else if (context === "start" && text.includes("provider") && (text.includes("enable") || text.includes("support"))) reason = "provider_disabled";
		else if (context === "session" && /expired|refresh_token|refresh token|jwt|session_not_found|session missing|not authenticated/.test(text)) reason = "session_expired";
		else if (context === "callback" && (text.includes("expired") || text.includes("flow_state_expired"))) reason = "expired_code";
		else if (context === "callback" && /invalid|not found|flow_state|bad_oauth|already used|validation/.test(text)) reason = "invalid_code";
		let message = MESSAGES[reason];
		if (!message) {
			message = raw || "Sign-in failed.";
			if (reason === "redirect_config") message += " Add this page's /auth/callback URL to Supabase Auth → URL Configuration → Redirect URLs.";
			if (reason === "provider_disabled") message += " Enable Google under Supabase Auth → Sign In / Providers → Google.";
		}
		return { reason, message };
	}

	function withTimeout<T>(promise: Promise<T>): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error("Authentication request timed out."), { name: "AuthTimeoutError" })), timeoutMs);
		});
		return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
	}

	async function dropLocalSession(): Promise<void> {
		try { await client.auth.signOut({ scope: "local" }); } catch { /* nothing further to clear */ }
	}

	function parseCallback(urlString: string): { kind: "none" } | { kind: "error"; message: string } | { kind: "code"; code: string } | { kind: "session"; accessToken: string; refreshToken: string } {
		const url = new URL(urlString, "http://localhost");
		const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
		const failure = url.searchParams.get("error_description") || url.searchParams.get("error") || fragment.get("error_description") || fragment.get("error");
		if (failure) return { kind: "error", message: failure };
		const code = url.searchParams.get("code");
		if (code) return { kind: "code", code };
		const accessToken = fragment.get("access_token");
		const refreshToken = fragment.get("refresh_token");
		if (accessToken && refreshToken) return { kind: "session", accessToken, refreshToken };
		return { kind: "none" };
	}

	async function finishCallback(key: string, exchange: () => Promise<{ error: { message?: string } | null }>): Promise<AuthSnapshot | undefined> {
		set({ status: "callback" });
		const attempt = exchange();
		let outcome: { error: { message?: string } | null };
		try {
			outcome = await withTimeout(attempt);
		} catch (error) {
			// A slow exchange must not create a session after the UI reported failure.
			attempt.then(async late => { if (!late.error) await dropLocalSession(); }, () => undefined);
			const failure = classify(error, "callback");
			const failed = set({ status: "denied", reason: failure.reason, message: failure.message });
			settled.set(key, failed);
			return failed;
		}
		if (outcome.error) {
			const failure = classify(outcome.error, "callback");
			const failed = set({ status: "denied", reason: failure.reason, message: failure.message });
			settled.set(key, failed);
			return failed;
		}
		settled.set(key, null);
		// confirm() clears the local session itself when the backend cannot confirm the identity.
		return confirm();
	}

	async function handleCallback(url: string): Promise<AuthSnapshot | undefined> {
		const parsed = (() => { try { return parseCallback(url); } catch { return undefined; } })();
		if (!parsed) return set({ status: "denied", reason: "invalid_code", message: MESSAGES.invalid_code });
		if (parsed.kind === "none") return undefined;
		if (parsed.kind === "error") {
			const failure = classify(parsed.message, "callback");
			return set({ status: "denied", reason: failure.reason, message: failure.reason === "unknown" ? parsed.message : failure.message });
		}
		const key = parsed.kind === "code" ? `code:${parsed.code}` : `session:${parsed.accessToken.slice(-16)}`;
		// A repeated delivery of the same callback must neither re-exchange the
		// single-use code nor overwrite the state produced by the first delivery.
		const running = inflight.get(key);
		if (running) return running;
		if (settled.has(key)) return settled.get(key) ?? snapshot;
		const work = parsed.kind === "code"
			? finishCallback(key, () => client.auth.exchangeCodeForSession(parsed.code))
			: finishCallback(key, () => client.auth.setSession({ access_token: parsed.accessToken, refresh_token: parsed.refreshToken }));
		inflight.set(key, work);
		try { return await work; } finally { inflight.delete(key); }
	}

	async function confirm(): Promise<AuthSnapshot> {
		set({ status: "authenticating" });
		try {
			const sessionResult = await withTimeout(client.auth.getSession());
			if (sessionResult.error) {
				const failure = classify(sessionResult.error, "session");
				if (failure.reason === "session_expired") { await dropLocalSession(); return set({ status: "expired", reason: "session_expired", message: MESSAGES.session_expired }); }
				return set({ status: "logged_out", reason: failure.reason, message: failure.message });
			}
			let session = sessionResult.data.session;
			if (!session) return set({ status: "logged_out" });
			let refreshed = false;
			const refresh = async (): Promise<boolean> => {
				refreshed = true;
				const result = await withTimeout(client.auth.refreshSession());
				if (result.error || !result.data.session) return false;
				session = result.data.session;
				return true;
			};
			if (typeof session.expires_at === "number" && session.expires_at * 1000 <= now() && !(await refresh())) {
				await dropLocalSession();
				return set({ status: "expired", reason: "session_expired", message: MESSAGES.session_expired });
			}
			let userResult = await withTimeout(client.auth.getUser());
			if ((userResult.error || !userResult.data.user) && !refreshed && await refresh()) userResult = await withTimeout(client.auth.getUser());
			if (userResult.error || !userResult.data.user) {
				await dropLocalSession();
				return set({ status: "expired", reason: "session_expired", message: MESSAGES.session_expired });
			}
			const user = userResult.data.user;
			if (options.authorize) {
				let decision: AuthorizationResult;
				try { decision = await withTimeout(options.authorize(user)); }
				catch (error) {
					const failure = classify(error, "session");
					return set({ status: "unauthorized", user, reason: "authorization_check_failed", message: `Access could not be verified. ${failure.reason === "unknown" ? failure.message : ""}`.trim() });
				}
				if (!decision.ok) return set({ status: "unauthorized", user, message: decision.message || "This account does not have access." });
			}
			return set({ status: "authenticated", user });
		} catch (error) {
			const failure = classify(error, "session");
			if (failure.reason === "session_expired") { await dropLocalSession(); return set({ status: "expired", reason: "session_expired", message: MESSAGES.session_expired }); }
			return set({ status: "logged_out", reason: failure.reason, message: failure.message });
		}
	}

	function resolve(): Promise<AuthSnapshot> {
		if (resolving) return resolving;
		const previous = snapshot;
		resolving = confirm().then(next => {
			// A failed callback or an expired session has no session behind it any more; keep explaining why
			// instead of collapsing to a bare "logged out" (clearing a dead session re-triggers auth listeners).
			if (next.status === "logged_out" && !next.message && (previous.status === "denied" || previous.status === "expired")) return set(previous);
			return next;
		}).finally(() => { resolving = undefined; });
		return resolving;
	}

	async function beginSignIn(redirectTo: string, skipBrowserRedirect?: boolean): Promise<{ url?: string; snapshot: AuthSnapshot }> {
		set({ status: "authenticating" });
		try {
			const result = await withTimeout(client.auth.signInWithOAuth({ provider: "google", options: skipBrowserRedirect ? { redirectTo, skipBrowserRedirect: true } : { redirectTo } }));
			if (result.error) throw result.error;
			const url = result.data && result.data.url ? result.data.url : undefined;
			if (!url) throw new Error("Google sign-in did not return a redirect URL. Enable the Google provider in Supabase.");
			return { url, snapshot };
		} catch (error) {
			const failure = classify(error, "start");
			return { snapshot: set({ status: "logged_out", reason: failure.reason, message: failure.message }) };
		}
	}

	async function signOut(): Promise<AuthSnapshot> {
		await dropLocalSession();
		settled.clear();
		return set({ status: "logged_out" });
	}

	return {
		get snapshot() { return snapshot; },
		handleCallback,
		resolve,
		beginSignIn,
		signOut,
	};
}

/** Source of the lifecycle for embedding into a page script; defines `createAuthLifecycle`. */
export const authLifecycleScript = `const createAuthLifecycle=${createAuthLifecycle.toString()};`;
