import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getInstallationPaths } from "./installation-paths.js";

const serverUrl = new URL("https://mcp.supabase.com/mcp?read_only=true&features=docs%2Cdatabase");
export const supabaseMcpCallback = "http://127.0.0.1:6769/providers/supabase/callback";

interface Credentials {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
}

class PersonalSupabaseOAuth implements OAuthClientProvider {
	private credentials: Credentials = {};
	private authorizationUrl?: URL;
	constructor(private readonly userId: string, private readonly oauthState?: string, private readonly interactive = false) {
		if (!/^[a-f0-9-]{36}$/i.test(userId)) throw new Error("A signed-in Pi Student account is required for Supabase MCP.");
	}
	private get filePath() { return path.join(getInstallationPaths().config, "mcp-auth", `supabase-${this.userId}.json`); }
	async load() {
		try { this.credentials = JSON.parse(await readFile(this.filePath, "utf8")) as Credentials; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		return this;
	}
	private async save() {
		await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(this.credentials), { mode: 0o600 });
		await rename(temporary, this.filePath);
	}
	get redirectUrl() { return supabaseMcpCallback; }
	get clientMetadata() { return { client_name: "Pi Student", redirect_uris: [supabaseMcpCallback], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; }
	state() { return this.oauthState ?? ""; }
	clientInformation() { return this.credentials.clientInformation; }
	async saveClientInformation(value: OAuthClientInformationMixed) { this.credentials.clientInformation = value; await this.save(); }
	tokens() { return this.credentials.tokens; }
	async saveTokens(value: OAuthTokens) { this.credentials.tokens = value; await this.save(); }
	redirectToAuthorization(url: URL) {
		if (!this.interactive) throw new Error("Connect your own Supabase account in Pi Student's Models settings first.");
		this.authorizationUrl = url;
	}
	async saveCodeVerifier(value: string) { this.credentials.codeVerifier = value; await this.save(); }
	codeVerifier() { if (!this.credentials.codeVerifier) throw new Error("Supabase sign-in expired. Start again."); return this.credentials.codeVerifier; }
	get authorization() { return this.authorizationUrl?.toString(); }
}

export async function beginSupabaseMcpLogin(userId: string, state: string): Promise<string | undefined> {
	const provider = await new PersonalSupabaseOAuth(userId, state, true).load();
	const status = await auth(provider, { serverUrl });
	return status === "REDIRECT" ? provider.authorization : undefined;
}

export async function finishSupabaseMcpLogin(userId: string, code: string): Promise<void> {
	const provider = await new PersonalSupabaseOAuth(userId, undefined, true).load();
	const status = await auth(provider, { serverUrl, authorizationCode: code });
	if (status !== "AUTHORIZED") throw new Error("Supabase sign-in did not complete.");
}

export async function supabaseMcpConnected(userId: string): Promise<boolean> {
	return !!(await new PersonalSupabaseOAuth(userId).load()).tokens();
}

export async function callPersonalSupabaseMcp(userId: string, method: "tools/list" | "tools/call", params: { name?: string; arguments?: Record<string, unknown> } = {}) {
	const provider = await new PersonalSupabaseOAuth(userId).load();
	if (!provider.tokens()) throw new Error("Connect your own Supabase account in Pi Student's Models settings first.");
	const client = new Client({ name: "pi-student", version: "0.1.0" });
	await client.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }));
	try {
		return method === "tools/list" ? await client.listTools() : await client.callTool({ name: params.name!, arguments: params.arguments ?? {} });
	} finally { await client.close(); }
}
