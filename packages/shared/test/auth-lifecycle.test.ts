import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { authLifecycleScript, createAuthLifecycle, type AuthClientLike, type AuthLifecycleOptions } from "@pi-student/shared/auth-lifecycle";

type Factory = (options: AuthLifecycleOptions) => ReturnType<typeof createAuthLifecycle>;
const embedded = runInNewContext(`${authLifecycleScript};createAuthLifecycle`, { setTimeout, clearTimeout, URL, URLSearchParams, Date, Map, Object, Error, Promise }) as Factory;
// The browser pages run the embedded source, so every scenario runs against both copies.
const implementations: Array<[string, Factory]> = [["module", createAuthLifecycle], ["embedded page script", embedded]];

const user = { id: "11111111-1111-1111-1111-111111111111", email: "teacher@example.test" };
const NOW = 1_700_000_000_000;
const future = NOW / 1000 + 3600;
const past = NOW / 1000 - 60;

interface Behavior {
	session?: { expires_at: number; user: typeof user } | null;
	exchange?: (code: string) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
	getUser?: () => Promise<{ data: { user: typeof user | null }; error: { message: string } | null }>;
	refresh?: () => Promise<{ data: { session: { expires_at: number; user: typeof user } | null }; error: { message: string } | null }>;
	signIn?: () => Promise<{ data: { url: string | null }; error: { message: string } | null }>;
}

/** Minimal in-memory stand-in for supabase-js auth storage semantics. */
function fakeClient(behavior: Behavior = {}) {
	const state = { session: behavior.session ?? null, exchanges: [] as string[], signOuts: 0 };
	const client = { auth: {
		getSession: async () => ({ data: { session: state.session }, error: null }),
		getUser: behavior.getUser ?? (async () => state.session ? { data: { user: state.session.user }, error: null } : { data: { user: null }, error: { message: "Auth session missing!" } }),
		refreshSession: behavior.refresh ?? (async () => ({ data: { session: state.session }, error: null })),
		exchangeCodeForSession: async (code: string) => {
			state.exchanges.push(code);
			const result = behavior.exchange ? await behavior.exchange(code) : { data: {}, error: null };
			if (!result.error) state.session = { expires_at: future, user };
			return result;
		},
		setSession: async () => { state.session = { expires_at: future, user }; return { data: {}, error: null }; },
		signInWithOAuth: behavior.signIn ?? (async () => ({ data: { url: "https://accounts.google.test/auth" }, error: null })),
		signOut: async () => { state.signOuts += 1; state.session = null; return { error: null }; },
	} } as unknown as AuthClientLike;
	return { client, state };
}

describe.each(implementations)("auth lifecycle (%s)", (_name, create) => {
	const make = (behavior: Behavior = {}, extra: Partial<AuthLifecycleOptions> = {}) => {
		const fake = fakeClient(behavior);
		return { ...fake, lifecycle: create({ client: fake.client, now: () => NOW, timeoutMs: 40, ...extra }) };
	};

	it("starts logged out with no session", async () => {
		const { lifecycle } = make();
		expect(lifecycle.snapshot.status).toBe("logged_out");
		expect((await lifecycle.resolve()).status).toBe("logged_out");
	});

	it("completes Google OAuth only after the backend confirms the user", async () => {
		const seen: string[] = [];
		const { lifecycle, state } = make({}, { onChange: snapshot => seen.push(snapshot.status) });
		const outcome = await lifecycle.handleCallback("http://127.0.0.1/auth/callback?code=good");
		expect(outcome).toMatchObject({ status: "authenticated", user });
		expect(state.exchanges).toEqual(["good"]);
		// callback -> authenticating (backend check) -> authenticated; never authenticated earlier.
		expect(seen).toEqual(["callback", "authenticating", "authenticated"]);
	});

	it("reports denied consent without touching the code exchange or leaving a session", async () => {
		const { lifecycle, state } = make();
		const outcome = await lifecycle.handleCallback("http://x/auth/callback?error=access_denied&error_description=User%20denied%20access");
		expect(outcome).toMatchObject({ status: "denied", reason: "consent_denied" });
		expect(state.exchanges).toEqual([]);
		expect(state.session).toBeNull();
		expect((await lifecycle.resolve()).status).toBe("denied");
	});

	it.each([
		["invalid code", { message: "invalid request: flow state not found", code: "flow_state_not_found" }, "invalid_code"],
		["expired code", { message: "invalid flow state, flow state has expired", code: "flow_state_expired" }, "expired_code"],
		["missing PKCE verifier", { message: "PKCE code verifier not found in storage." }, "missing_verifier"],
		["mismatched PKCE verifier", { message: "code challenge does not match previously saved code verifier", code: "bad_code_verifier" }, "missing_verifier"],
	])("rejects an %s and creates no session", async (_label, error, reason) => {
		const { lifecycle, state } = make({ exchange: async () => ({ data: {}, error }) });
		const outcome = await lifecycle.handleCallback("http://x/auth/callback?code=bad");
		expect(outcome).toMatchObject({ status: "denied", reason });
		expect(outcome?.user).toBeUndefined();
		expect(state.session).toBeNull();
	});

	it("times out a hung exchange and discards a session that arrives late", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const { lifecycle, state } = make({ exchange: async () => { await gate; return { data: {}, error: null }; } });
		const outcome = await lifecycle.handleCallback("http://x/auth/callback?code=slow");
		expect(outcome).toMatchObject({ status: "denied", reason: "timeout" });
		release();
		await new Promise(resolve => setTimeout(resolve, 5));
		expect(state.session).toBeNull();
		expect(state.signOuts).toBeGreaterThan(0);
	});

	it("uses an existing valid session without a callback", async () => {
		const { lifecycle, state } = make({ session: { expires_at: future, user } });
		expect(await lifecycle.handleCallback("http://x/")).toBeUndefined();
		expect(await lifecycle.resolve()).toMatchObject({ status: "authenticated", user });
		expect(state.exchanges).toEqual([]);
	});

	it("refreshes an expired access token and stays signed in", async () => {
		const fresh = { expires_at: future, user };
		const refresh = vi.fn(async () => ({ data: { session: fresh }, error: null }));
		const { lifecycle } = make({ session: { expires_at: past, user }, refresh });
		expect(await lifecycle.resolve()).toMatchObject({ status: "authenticated" });
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("reports expired and clears local state when refresh fails", async () => {
		const { lifecycle, state } = make({ session: { expires_at: past, user }, refresh: async () => ({ data: { session: null }, error: { message: "Invalid Refresh Token: Refresh Token Not Found" } }) });
		expect(await lifecycle.resolve()).toMatchObject({ status: "expired", reason: "session_expired" });
		expect(state.session).toBeNull();
	});

	it("keeps explaining an expired session when clearing it re-triggers a check", async () => {
		const { lifecycle } = make({ session: { expires_at: past, user }, refresh: async () => ({ data: { session: null }, error: { message: "refresh_token_not_found" } }) });
		expect((await lifecycle.resolve()).status).toBe("expired");
		expect(await lifecycle.resolve()).toMatchObject({ status: "expired", reason: "session_expired" });
	});

	it("does not trust an unexpired local session the backend rejects", async () => {
		const { lifecycle, state } = make({
			session: { expires_at: future, user },
			getUser: async () => ({ data: { user: null }, error: { message: "invalid JWT: token is expired" } }),
			refresh: async () => ({ data: { session: null }, error: { message: "refresh_token_not_found" } }),
		});
		expect(await lifecycle.resolve()).toMatchObject({ status: "expired" });
		expect(state.session).toBeNull();
	});

	it("processes a duplicate callback once, including concurrent delivery", async () => {
		const { lifecycle, state } = make();
		const url = "http://x/auth/callback?code=once";
		const [first, second] = await Promise.all([lifecycle.handleCallback(url), lifecycle.handleCallback(url)]);
		const third = await lifecycle.handleCallback(url);
		expect(state.exchanges).toEqual(["once"]);
		expect([first?.status, second?.status, third?.status]).toEqual(["authenticated", "authenticated", "authenticated"]);
	});

	it("replays the original failure for a duplicate failed callback", async () => {
		const { lifecycle, state } = make({ exchange: async () => ({ data: {}, error: { message: "flow state not found" } }) });
		const first = await lifecycle.handleCallback("http://x/auth/callback?code=dead");
		const second = await lifecycle.handleCallback("http://x/auth/callback?code=dead");
		expect(second).toEqual(first);
		expect(state.exchanges).toEqual(["dead"]);
	});

	it("keeps an existing session when a stale callback fails", async () => {
		const { lifecycle, state } = make({ session: { expires_at: future, user }, exchange: async () => ({ data: {}, error: { message: "flow state not found" } }) });
		expect(await lifecycle.handleCallback("http://x/auth/callback?code=stale")).toMatchObject({ status: "denied", reason: "invalid_code" });
		expect(state.session).not.toBeNull();
		// The backend still confirms the earlier identity, so the UI returns to authenticated.
		expect((await lifecycle.resolve()).status).toBe("authenticated");
	});

	it("separates signed-in-but-unauthorized from authenticated", async () => {
		const authorize = vi.fn(async () => ({ ok: false, message: "No organization access." }));
		const { lifecycle } = make({ session: { expires_at: future, user } }, { authorize });
		expect(await lifecycle.resolve()).toMatchObject({ status: "unauthorized", user, message: "No organization access." });
		expect(authorize).toHaveBeenCalledWith(user);
	});

	it("fails closed when the authorization check itself errors", async () => {
		const { lifecycle } = make({ session: { expires_at: future, user } }, { authorize: async () => { throw new Error("network down"); } });
		expect(await lifecycle.resolve()).toMatchObject({ status: "unauthorized", reason: "authorization_check_failed" });
	});

	it("maps sign-in start failures to actionable messages", async () => {
		const redirect = make({ signIn: async () => ({ data: { url: null }, error: { message: "redirect_to is not allowed" } }) });
		expect((await redirect.lifecycle.beginSignIn("http://x/auth/callback")).snapshot).toMatchObject({ status: "logged_out", reason: "redirect_config" });
		const missing = make({ signIn: async () => ({ data: { url: null }, error: null }) });
		expect((await missing.lifecycle.beginSignIn("http://x/auth/callback")).snapshot.message).toContain("Enable the Google provider");
		const ok = make();
		const started = await ok.lifecycle.beginSignIn("http://x/auth/callback", true);
		expect(started.url).toBe("https://accounts.google.test/auth");
		expect(started.snapshot.status).toBe("authenticating");
	});

	it("signs out to a clean logged-out state", async () => {
		const { lifecycle, state } = make({ session: { expires_at: future, user } });
		await lifecycle.resolve();
		expect(await lifecycle.signOut()).toMatchObject({ status: "logged_out" });
		expect(state.session).toBeNull();
	});

	it("supports the legacy implicit-flow fragment", async () => {
		const { lifecycle } = make();
		expect(await lifecycle.handleCallback("http://x/auth/callback#access_token=a&refresh_token=b")).toMatchObject({ status: "authenticated" });
	});
});
