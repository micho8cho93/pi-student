import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type ApiKeyCredential = { type: "api_key"; key?: string; env?: Record<string, string> };
type OAuthCredential = { type: "oauth"; refresh: string; access: string; expires: number; [key: string]: unknown };
type Credential = ApiKeyCredential | OAuthCredential;
type AuthData = Record<string, Credential>;

/** Pi's default credential path. It is intentionally outside the project. */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/**
 * Minimal durable CredentialStore compatible with pi-ai's runtime.
 * Writes are atomic and the resulting file is owner-readable only.
 */
export class FileCredentialStore {
	constructor(private readonly authPath = getAuthPath()) {}

	async read(providerId: string): Promise<Credential | undefined> {
		const data = await this.load();
		return data[providerId];
	}

	async list(): Promise<ReadonlyArray<{ providerId: string; type: Credential["type"] }>> {
		const data = await this.load();
		return Object.entries(data).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		const data = await this.load();
		const next = await fn(data[providerId]);
		if (next !== undefined) {
			data[providerId] = next;
			await this.save(data);
		}
		return next;
	}

	async delete(providerId: string): Promise<void> {
		const data = await this.load();
		if (!(providerId in data)) return;
		delete data[providerId];
		await this.save(data);
	}

	private async load(): Promise<AuthData> {
		try {
			const raw = await readFile(this.authPath, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (!isAuthData(parsed)) {
				throw new Error("the file does not contain a valid Pi credential map");
			}
			return parsed;
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return {};
			if (error instanceof SyntaxError) {
				throw new Error(`Could not read Pi credentials at ${this.authPath}: invalid JSON`);
			}
			throw new Error(`Could not read Pi credentials at ${this.authPath}: ${errorMessage(error)}`);
		}
	}

	private async save(data: AuthData): Promise<void> {
		await mkdir(dirname(this.authPath), { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.authPath}.${process.pid}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, this.authPath);
		await chmod(this.authPath, 0o600);
	}
}

export async function persistApiKey(providerId: string, apiKey: string, authPath = getAuthPath()): Promise<void> {
	const store = new FileCredentialStore(authPath);
	await store.modify(providerId, async () => ({ type: "api_key", key: apiKey }));
}

function isAuthData(value: unknown): value is AuthData {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.values(value).every((credential) => {
		if (!credential || typeof credential !== "object" || !("type" in credential)) return false;
		return credential.type === "api_key" || credential.type === "oauth";
	});
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
