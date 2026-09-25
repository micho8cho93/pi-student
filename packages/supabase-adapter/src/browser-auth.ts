import { createServer } from "node:http";
import process from "node:process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openBrowser } from "@pi-student/shared/open-browser";
import { createAuthLifecycle, type AuthClientLike } from "@pi-student/shared/auth-lifecycle";
import { describeAuthError, teacherAuthCallbackUrl } from "@pi-student/classroom/auth-flow";

export interface BrowserAuthOptions {
	open?: (url: string) => void;
	/** How long to wait for the user to finish in the browser. */
	timeoutMs?: number;
	/** Bound for each individual auth-service request. */
	requestTimeoutMs?: number;
}

const CALLBACK_PATH = "/auth/callback";

/**
 * Terminal sign-in. Resolves only once the auth service has confirmed the
 * identity; every failure (denied consent, bad or expired code, missing PKCE
 * verifier, timeout) rejects with a readable message and leaves no session.
 */
export async function authenticateInBrowser(
	client: SupabaseClient,
	notify: (message: string) => void = message => process.stdout.write(`${message}\n`),
	options: BrowserAuthOptions = {},
): Promise<void> {
	const lifecycle = createAuthLifecycle({ client: client as unknown as AuthClientLike, timeoutMs: options.requestTimeoutMs });
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let resolveAuth!: () => void;
	let rejectAuth!: (error: Error) => void;
	const completed = new Promise<void>((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject; });
	const server = createServer(async (request, response) => {
		const send = (status: number, body: string) => { response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); response.end(body); };
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			// Browsers also request /favicon.ico and probes hit other paths; those must not end the sign-in.
			if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) return send(404, "Not found");
			const outcome = await lifecycle.handleCallback(url.toString());
			if (!outcome) return send(400, "The sign-in callback did not include a code.");
			if (outcome.status === "authenticated") { send(200, "Pi Student sign-in complete. You can close this tab."); resolveAuth(); return; }
			send(400, "Pi Student could not complete sign-in.");
			rejectAuth(new Error(outcome.message ?? "Sign-in did not complete."));
		} catch (error) {
			send(400, "Pi Student could not complete sign-in.");
			rejectAuth(error instanceof Error ? error : new Error(String(error)));
		}
	});
	await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Could not create the local authentication callback.");
		const started = await lifecycle.beginSignIn(teacherAuthCallbackUrl(`http://127.0.0.1:${address.port}`), true);
		if (!started.url) throw new Error(describeAuthError(new Error(started.snapshot.message ?? "Supabase did not return a Google sign-in URL.")));
		(options.open ?? openBrowser)(started.url); notify("Complete Google sign-in in your browser…");
		const limit = options.timeoutMs ?? 10 * 60 * 1000;
		await Promise.race([completed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`Sign-in timed out after ${limit >= 60000 ? `${Math.round(limit / 60000)} minutes` : `${Math.round(limit / 1000)} seconds`}. Run the command again to retry.`)), limit); })]);
		notify("Signed in to the classroom service.");
	} finally { clearTimeout(timeout); server.close(); }
}
