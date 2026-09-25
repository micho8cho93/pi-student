import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { normalizeOllamaUrl, OllamaDiscoveryError, readOllamaConfig, registerOllama, saveOllamaUrl } from "../src/ollama.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it("discovers local Ollama models and makes them available without an API key", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-student-ollama-"));
	directories.push(directory);
	const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const localFetch = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3.1:8b" }] }), { status: 200 }));

	expect(await registerOllama(runtime, "http://localhost:11434/v1", localFetch as typeof fetch)).toEqual(["qwen2.5-coder:7b", "llama3.1:8b"]);
	await runtime.refresh({ allowNetwork: false, providers: ["ollama"] });
	expect(localFetch).toHaveBeenCalledWith("http://localhost:11434/api/tags", expect.objectContaining({ signal: expect.any(AbortSignal) }));
	expect(runtime.getProviderAuthStatus("ollama").configured).toBe(true);
	expect((await runtime.getAvailable("ollama")).map(model => model.id)).toEqual(["qwen2.5-coder:7b", "llama3.1:8b"]);
	expect(runtime.getModel("ollama", "qwen2.5-coder:7b")).toMatchObject({
		baseUrl: "http://localhost:11434/v1", api: "openai-completions", compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
	});
});

it("sends a chat request to the selected local model", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-student-ollama-"));
	directories.push(directory);
	let requestBody: Record<string, unknown> | undefined;
	const server = createServer(async (request, response) => {
		if (request.url === "/api/tags") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ models: [{ name: "local-test:latest" }] }));
			return;
		}
		if (request.url === "/v1/chat/completions") {
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			requestBody = JSON.parse(body) as Record<string, unknown>;
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "local-test:latest", choices: [{ index: 0, delta: { content: "Hello locally" }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "local-test:latest", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
			response.end("data: [DONE]\n\n");
			return;
		}
		response.writeHead(404).end();
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Local test server did not bind.");
		const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
		await registerOllama(runtime, `http://127.0.0.1:${address.port}`);
		await runtime.refresh({ allowNetwork: false, providers: ["ollama"] });
		const model = runtime.getModel("ollama", "local-test:latest");
		if (!model) throw new Error("Ollama model was not registered.");
		const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "Hi", timestamp: Date.now() }] });
		expect(result.content).toContainEqual({ type: "text", text: "Hello locally" });
		expect(requestBody).toMatchObject({ model: "local-test:latest", stream: true, messages: [{ role: "user", content: "Hi" }] });
		expect(requestBody).not.toHaveProperty("reasoning_effort");
	} finally {
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
});

it("stores the selected local model outside the project and only accepts loopback addresses", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-student-ollama-"));
	directories.push(directory);
	const configPath = join(directory, "ollama.json");
	await saveOllamaUrl("http://127.0.0.1:11434/v1", "qwen2.5-coder:7b", configPath);
	expect(await readOllamaConfig(configPath)).toEqual({ url: "http://127.0.0.1:11434", modelId: "qwen2.5-coder:7b" });
	expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ url: "http://127.0.0.1:11434", modelId: "qwen2.5-coder:7b" });
	expect((await stat(configPath)).mode & 0o777).toBe(0o600);
	expect(() => normalizeOllamaUrl("http://192.168.1.10:11434")).toThrow(/local HTTP/);
	expect(() => normalizeOllamaUrl("https://example.com")).toThrow(/local HTTP/);
});

it("reports a stopped server and an empty local model list", async () => {
	const runtime = { registerProvider: vi.fn() } as unknown as ModelRuntime;
	await expect(registerOllama(runtime, "http://127.0.0.1:11434", vi.fn(async () => { throw new Error("offline"); }) as typeof fetch)).rejects.toThrow(/Start it with ollama serve/);
	await expect(registerOllama(runtime, "http://127.0.0.1:11434", vi.fn(async () => new Response('{"models":[]}')) as typeof fetch)).rejects.toThrow(/ollama pull/);
	expect(runtime.registerProvider).not.toHaveBeenCalled();
});

it("distinguishes incompatible, malformed, and timed-out discovery from offline state", async () => {
	const runtime = { registerProvider: vi.fn() } as unknown as ModelRuntime;
	await expect(registerOllama(runtime, "http://127.0.0.1:11434", vi.fn(async () => new Response("not-json", { status: 200 })) as typeof fetch))
		.rejects.toMatchObject({ code: "OLLAMA_INVALID_RESPONSE" } satisfies Partial<OllamaDiscoveryError>);
	await expect(registerOllama(runtime, "http://127.0.0.1:11434", vi.fn(async () => new Response("", { status: 404 })) as typeof fetch))
		.rejects.toMatchObject({ code: "OLLAMA_INCOMPATIBLE" } satisfies Partial<OllamaDiscoveryError>);
	await expect(registerOllama(runtime, "http://127.0.0.1:11434", vi.fn(async () => { throw new DOMException("timeout", "TimeoutError"); }) as typeof fetch))
		.rejects.toMatchObject({ code: "OLLAMA_TIMEOUT" } satisfies Partial<OllamaDiscoveryError>);
});

it("replaces stale model inventory when a server reconnects or changes models", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-student-ollama-reconnect-"));
	directories.push(directory);
	const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
	let payload = { models: [{ name: "old-model" }] };
	const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
	await registerOllama(runtime, "http://127.0.0.1:11434", fetchImpl as typeof fetch);
	await runtime.refresh({ allowNetwork: false, providers: ["ollama"] });
	expect((await runtime.getAvailable("ollama")).map(model => model.id)).toEqual(["old-model"]);
	payload = { models: [{ model: "new-model" }] };
	await registerOllama(runtime, "http://127.0.0.1:11434", fetchImpl as typeof fetch);
	await runtime.refresh({ allowNetwork: false, providers: ["ollama"] });
	expect((await runtime.getAvailable("ollama")).map(model => model.id)).toEqual(["new-model"]);
});
