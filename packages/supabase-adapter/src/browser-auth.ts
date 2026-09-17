import { createServer } from "node:http";
import process from "node:process";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openBrowser } from "@pi-student/shared/open-browser";
import { describeAuthError, teacherAuthCallbackUrl } from "@pi-student/classroom/auth-flow";

export async function authenticateInBrowser(client: SupabaseClient, notify: (message: string) => void = message => process.stdout.write(`${message}\n`)): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let resolveAuth!: () => void;
	let rejectAuth!: (error: Error) => void;
	const completed = new Promise<void>((resolve, reject) => { resolveAuth = resolve; rejectAuth = reject; });
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			const code = url.searchParams.get("code");
			if (!code) throw new Error(url.searchParams.get("error_description") ?? "The sign-in callback did not include a code.");
			const { error } = await client.auth.exchangeCodeForSession(code);
			if (error) throw error;
			response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); response.end("Pi Student sign-in complete. You can close this tab."); resolveAuth();
		} catch (error) {
			response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }); response.end("Pi Student could not complete sign-in."); rejectAuth(error instanceof Error ? error : new Error(String(error)));
		}
	});
	await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Could not create the local authentication callback.");
	const redirectTo = teacherAuthCallbackUrl(`http://127.0.0.1:${address.port}`);
	try {
		const { data, error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo, skipBrowserRedirect: true } });
		if (error || !data.url) throw new Error(describeAuthError(error ?? new Error("Supabase did not return a Google sign-in URL.")));
		openBrowser(data.url); notify("Complete Google sign-in in your browser…");
		await Promise.race([completed, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Sign-in timed out after ten minutes.")), 10 * 60 * 1000); })]);
		notify("Signed in to the classroom service.");
	} finally { clearTimeout(timeout); server.close(); }
}
