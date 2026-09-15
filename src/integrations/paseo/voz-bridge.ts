import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getVozCommand, transcribeWithVozAudio } from "../../voice/dictation.js";
import { readTeacherContext } from "../../telemetry/local-store.js";

export const PASEO_VOZ_BRIDGE_PORT = 6768;
export const PASEO_VOZ_BRIDGE_URL = `http://127.0.0.1:${PASEO_VOZ_BRIDGE_PORT}/v1`;

const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

/**
 * Small loopback adapter for Paseo's OpenAI-compatible STT provider. Paseo's
 * browser mic streams PCM to its daemon; the daemon posts short WAV segments
 * here, and Voz does the actual on-device transcription.
 */
export async function runVozBridge(port = PASEO_VOZ_BRIDGE_PORT): Promise<void> {
	const server = createServer((request, response) => {
		void handleRequest(request, response).catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			writeJson(response, 500, { error: { message } });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	await new Promise<void>(() => {
		// The bridge is intentionally a daemon child and exits on SIGTERM/SIGINT.
		const close = () => server.close(() => process.exit(0));
		process.once("SIGTERM", close);
		process.once("SIGINT", close);
	});
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
	if (request.method === "GET" && request.url === "/health") {
		writeJson(response, 200, { ok: true, provider: "voz", local: true });
		return;
	}
	if (request.method !== "POST" || !request.url?.endsWith("/audio/transcriptions")) {
		writeJson(response, 404, { error: { message: "Not found" } });
		return;
	}

	const context = await readTeacherContext();
	if (context.projectId && (!context.policy || !context.policy.settings.accessibility.dictation)) {
		writeJson(response, 403, { error: { message: "Dictation is disabled or project controls are unavailable." } });
		request.resume(); return;
	}
	const body = await readBody(request);
	const audio = await extractAudio(body, request.headers["content-type"]);
	const audioPath = join(tmpdir(), `pi-student-paseo-voz-${randomUUID()}.wav`);
	await writeFile(audioPath, audio, { mode: 0o600 });
	try {
		const text = await transcribeWithVozAudio(audioPath, getVozCommand(process.env));
		writeJson(response, 200, { text, model: "voz" });
	} finally {
		await unlink(audioPath).catch(() => undefined);
	}
}

function readBody(request: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", chunk => {
			const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += value.length;
			if (size > MAX_AUDIO_BYTES) {
				request.destroy();
				reject(new Error("Audio recording is too large for Voz."));
				return;
			}
			chunks.push(value);
		});
		request.once("end", () => resolve(Buffer.concat(chunks)));
		request.once("error", reject);
	});
}

export async function extractAudio(body: Buffer, contentType: string | undefined): Promise<Buffer> {
	if (!contentType?.toLowerCase().startsWith("multipart/form-data")) return body;
	// The OpenAI client may put model/options before the file. Parse the named
	// file part instead of treating the first multipart field as audio.
	const form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
	const file = form.get("file");
	if (!file || typeof file === "string" || file.size === 0) throw new Error("Paseo sent a transcription request without an audio file.");
	return Buffer.from(await file.arrayBuffer());
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
	response.end(body);
}
