import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticateInBrowser } from "../src/browser-auth.js";
import { SupabaseIdentityProvider } from "../src/identity-provider.js";

const user = { id: "22222222-2222-2222-2222-222222222222", email: "student@example.test" };
const future = Date.now() / 1000 + 3600;

function fakeSupabase(options: { exchange?: () => Promise<{ data: unknown; error: { message: string; code?: string } | null }>; session?: { expires_at: number; user: typeof user } | null; refresh?: () => Promise<{ data: { session: null }; error: { message: string } }>; getUserError?: string } = {}) {
	const state = { session: options.session ?? null, exchanges: 0, signOuts: 0 };
	const client = { auth: {
		signInWithOAuth: async () => ({ data: { url: "https://accounts.google.test/authorize" }, error: null }),
		exchangeCodeForSession: async () => {
			state.exchanges += 1;
			const result = options.exchange ? await options.exchange() : { data: {}, error: null };
			if (!result.error) state.session = { expires_at: future, user };
			return result;
		},
		getSession: async () => ({ data: { session: state.session }, error: null }),
		getUser: async () => options.getUserError ? { data: { user: null }, error: { message: options.getUserError } } : state.session ? { data: { user: state.session.user }, error: null } : { data: { user: null }, error: { message: "Auth session missing!" } },
		refreshSession: options.refresh ?? (async () => ({ data: { session: state.session }, error: null })),
		setSession: async () => ({ data: {}, error: null }),
		signOut: async () => { state.signOuts += 1; state.session = null; return { error: null }; },
	} };
	return { client: client as never, state };
}

/** Starts sign-in against the real local callback server and returns the redirect URL a browser would be sent back to. */
async function callbackBase(fake: ReturnType<typeof fakeSupabase>, timeoutMs?: number) {
	// The port is chosen by the OS; capture it from the redirect the client asks Supabase to use.
	let redirectTo = "";
	const original = (fake.client as { auth: { signInWithOAuth: (input: { options: { redirectTo: string } }) => Promise<unknown> } }).auth.signInWithOAuth;
	(fake.client as { auth: { signInWithOAuth: unknown } }).auth.signInWithOAuth = async (input: { options: { redirectTo: string } }) => { redirectTo = input.options.redirectTo; return original(input); };
	let resolveOpen!: () => void;
	const open = new Promise<void>(resolve => { resolveOpen = resolve; });
	const result = authenticateInBrowser(fake.client, () => undefined, { open: () => resolveOpen(), timeoutMs, requestTimeoutMs: 500 }).then(() => "ok" as const, error => error as Error);
	await open;
	return { redirectTo, result };
}

afterEach(() => vi.restoreAllMocks());

describe("terminal Google sign-in over the real callback server", () => {
	it("succeeds after a valid code and the backend confirms the user", async () => {
		const fake = fakeSupabase();
		const { redirectTo, result } = await callbackBase(fake);
		expect(redirectTo).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
		const response = await fetch(`${redirectTo}?code=abc`);
		expect(response.status).toBe(200);
		expect(await result).toBe("ok");
		expect(fake.state.exchanges).toBe(1);
	});

	it("ignores favicon and probe requests instead of failing the sign-in", async () => {
		const fake = fakeSupabase();
		const { redirectTo, result } = await callbackBase(fake);
		const origin = new URL(redirectTo).origin;
		expect((await fetch(`${origin}/favicon.ico`)).status).toBe(404);
		expect((await fetch(`${origin}/`)).status).toBe(404);
		expect((await fetch(`${redirectTo}?code=abc`)).status).toBe(200);
		expect(await result).toBe("ok");
	});

	it("rejects denied consent and never exchanges a code", async () => {
		const fake = fakeSupabase();
		const { redirectTo, result } = await callbackBase(fake);
		const response = await fetch(`${redirectTo}?error=access_denied&error_description=User%20denied%20access`);
		expect(response.status).toBe(400);
		expect(await result).toMatchObject({ message: expect.stringMatching(/cancelled|denied/i) });
		expect(fake.state.exchanges).toBe(0);
		expect(fake.state.session).toBeNull();
	});

	it.each([
		["invalid code", "flow state not found", /not valid/i],
		["expired code", "flow state has expired", /expired/i],
		["missing PKCE verifier", "PKCE code verifier not found in storage.", /same browser/i],
	])("rejects an %s and leaves no session", async (_label, message, expected) => {
		const fake = fakeSupabase({ exchange: async () => ({ data: {}, error: { message } }) });
		const { redirectTo, result } = await callbackBase(fake);
		expect((await fetch(`${redirectTo}?code=bad`)).status).toBe(400);
		expect(await result).toMatchObject({ message: expect.stringMatching(expected) });
		expect(fake.state.session).toBeNull();
	});

	it("does not report success when the backend cannot confirm the exchanged session", async () => {
		const fake = fakeSupabase({ getUserError: "invalid JWT", refresh: async () => ({ data: { session: null }, error: { message: "refresh_token_not_found" } }) });
		const { redirectTo, result } = await callbackBase(fake);
		expect((await fetch(`${redirectTo}?code=abc`)).status).toBe(400);
		expect(await result).toBeInstanceOf(Error);
		expect(fake.state.session).toBeNull();
	});

	it("times out when the browser never returns", async () => {
		const fake = fakeSupabase();
		const { result } = await callbackBase(fake, 60);
		expect(await result).toMatchObject({ message: expect.stringContaining("timed out") });
	});

	it("handles a duplicate callback without a second exchange", async () => {
		const fake = fakeSupabase();
		const { redirectTo, result } = await callbackBase(fake);
		const [first, second] = await Promise.all([fetch(`${redirectTo}?code=abc`), fetch(`${redirectTo}?code=abc`)]);
		expect([first.status, second.status]).toEqual([200, 200]);
		expect(await result).toBe("ok");
		expect(fake.state.exchanges).toBe(1);
	});
});

describe("runtime identity from the auth backend", () => {
	it("maps a confirmed session to the signed-in identity", async () => {
		const fake = fakeSupabase({ session: { expires_at: future, user } });
		expect(await new SupabaseIdentityProvider(fake.client, "student").getIdentity()).toEqual({ kind: "student", userId: user.id, email: user.email });
	});
	it("is personal, not a crash, when logged out", async () => {
		expect(await new SupabaseIdentityProvider(fakeSupabase().client).getIdentity()).toEqual({ kind: "personal" });
	});
	it("treats an expired, unrefreshable session as signed out and clears it", async () => {
		const fake = fakeSupabase({ session: { expires_at: 1, user }, refresh: async () => ({ data: { session: null }, error: { message: "Invalid Refresh Token: Refresh Token Not Found" } }) });
		expect(await new SupabaseIdentityProvider(fake.client).getIdentity()).toEqual({ kind: "personal" });
		expect(fake.state.session).toBeNull();
	});
	it("still surfaces non-session failures such as an outage", async () => {
		const fake = fakeSupabase({ session: { expires_at: future, user }, getUserError: "fetch failed" });
		// A backend rejection of the token is a session problem; only a thrown transport error is an outage.
		(fake.client as { auth: { getSession: unknown } }).auth.getSession = async () => { throw new Error("fetch failed"); };
		await expect(new SupabaseIdentityProvider(fake.client).getIdentity()).rejects.toThrow("fetch failed");
	});
});
