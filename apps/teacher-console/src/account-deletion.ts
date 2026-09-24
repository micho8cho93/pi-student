import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseConfig } from "@pi-student/supabase-adapter/config";

function respond(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
	response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const part of request) {
		const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
		size += chunk.length;
		if (size > 4096) throw new Error("Confirmation is too large.");
		chunks.push(chunk);
	}
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid confirmation.");
	return parsed as Record<string, unknown>;
}

export async function handleTeacherAccountDeletion(
	request: IncomingMessage,
	response: ServerResponse,
	config: SupabaseConfig,
	serverOrigin: string,
	serviceRoleKey = process.env.PI_STUDENT_SUPABASE_SERVICE_ROLE_KEY?.trim(),
): Promise<void> {
	if (request.headers.origin !== serverOrigin) {
		respond(response, 403, { error: "Open account settings in this teacher workspace." });
		return;
	}
	if (!serviceRoleKey) {
		respond(response, 503, { error: "Account deletion is unavailable until the server has PI_STUDENT_SUPABASE_SERVICE_ROLE_KEY configured." });
		return;
	}
	const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (!token) { respond(response, 401, { error: "Sign in again before deleting your account." }); return; }
	if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
		respond(response, 415, { error: "JSON confirmation is required." });
		return;
	}
	try {
		const body = await readBody(request);
		const authClient = createClient(config.url, config.publishableKey, {
			auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
			global: { headers: { Authorization: `Bearer ${token}` } },
		});
		const { data: auth, error: authError } = await authClient.auth.getUser(token);
		if (authError || !auth.user?.email) { respond(response, 401, { error: "Sign in again before deleting your account." }); return; }
		const phrase = `I confirm that I am deleting ${auth.user.email}`;
		if (body.phrase !== phrase || body.confirmed !== true) {
			respond(response, 400, { error: "Complete both deletion confirmations." });
			return;
		}
		const admin = createClient(config.url, serviceRoleKey, {
			auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
		});
		const { error: adminError } = await admin.auth.admin.getUserById(auth.user.id);
		if (adminError) { respond(response, 503, { error: "Account deletion is unavailable because server credentials could not be verified." }); return; }
		const { error: preparationError } = await authClient.rpc("prepare_teacher_account_deletion", {
			confirmation_phrase_input: phrase,
			confirmed_input: true,
		});
		if (preparationError) { respond(response, 409, { error: preparationError.message }); return; }
		const { error: deletionError } = await admin.auth.admin.deleteUser(auth.user.id, true);
		if (deletionError) { respond(response, 503, { error: `Account access could not be removed: ${deletionError.message}. Try again.` }); return; }
		respond(response, 200, { deleted: true });
	} catch (error) {
		respond(response, 400, { error: error instanceof Error ? error.message : "Invalid confirmation." });
	}
}
