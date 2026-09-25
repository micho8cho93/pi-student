import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface UpstreamProvider { baseUrl: string; apiKey: string }
export interface GatewayOptions {
  db: Pick<SupabaseClient, "auth" | "rpc">;
  providers: Record<string, UpstreamProvider>;
  fetchImpl?: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 1_000_000;
const INPUT_BOUND = 32_000;
const OUTPUT_BOUND = 4_096;

function respond(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request body.");
  return value as Record<string, unknown>;
}
function noImages(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(noImages);
  if (value && typeof value === "object") return Object.entries(value).every(([key, item]) => key !== "image_url" && key !== "input_image" && noImages(item));
  return true;
}
function usageFromProvider(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined {
  if (!value || typeof value !== "object") return;
  const usage = value as Record<string, unknown>;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const prompt = Number(usage.prompt_tokens), output = Number(usage.completion_tokens), cacheRead = Number(details.cached_tokens ?? 0);
  if (![prompt, output, cacheRead].every(Number.isSafeInteger) || prompt < cacheRead || cacheRead < 0 || output < 0) return;
  return { input: prompt - cacheRead, output, cacheRead, cacheWrite: 0 };
}
function streamCompletion(response: ServerResponse, completion: Record<string, unknown>, usage: ReturnType<typeof usageFromProvider>): void {
  const choice = (completion.choices as Array<Record<string, unknown>>)[0]!;
  const message = choice.message as Record<string, unknown>;
  const chunk = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model,
    choices: [{ index: 0, delta: { role: "assistant", content: message.content ?? null, ...(message.tool_calls ? { tool_calls: (message.tool_calls as Array<Record<string, unknown>>).map((call, index) => ({ index, ...call })) } : {}) }, finish_reason: null }] };
  const finish = { id: completion.id, object: "chat.completion.chunk", created: completion.created, model: completion.model,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? "stop" }] };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-content-type-options": "nosniff" });
  response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write(`data: ${JSON.stringify(finish)}\n\n`);
  response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: usage!.input + usage!.cacheRead, completion_tokens: usage!.output, total_tokens: usage!.input + usage!.cacheRead + usage!.output, prompt_tokens_details: { cached_tokens: usage!.cacheRead } } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

export function createModelGateway(options: GatewayOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") return respond(response, 200, { ok: true });
    const match = request.method === "POST" && request.url?.match(/^\/projects\/([0-9a-f-]{36})\/v1\/chat\/completions$/i);
    if (!match || !UUID.test(match[1]!)) return respond(response, 404, { error: { message: "Not found." } });
    try {
      const token = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      if (!token) return respond(response, 401, { error: { message: "Sign-in required." } });
      const verified = await options.db.auth.getUser(token);
      if (verified.error || !verified.data.user) return respond(response, 401, { error: { message: "Sign-in expired." } });
      const sessionId = request.headers["x-pi-session-id"];
      if (typeof sessionId !== "string" || !UUID.test(sessionId)) return respond(response, 400, { error: { message: "Session ID required." } });
      const body = await readJson(request);
      const profileId = body.model;
      if (typeof profileId !== "string" || !UUID.test(profileId) || !Array.isArray(body.messages) || !noImages(body.messages)) {
        return respond(response, 400, { error: { message: "Invalid text-only model request." } });
      }
      if (Buffer.byteLength(JSON.stringify(body), "utf8") + body.messages.length * 100 > INPUT_BOUND) {
        return respond(response, 413, { error: { message: "Model context is too large." } });
      }
      const requestedOutput = body.max_tokens ?? body.max_completion_tokens ?? OUTPUT_BOUND;
      if (!Number.isSafeInteger(requestedOutput) || Number(requestedOutput) < 1 || Number(requestedOutput) > OUTPUT_BOUND) {
        return respond(response, 400, { error: { message: "Invalid model output limit." } });
      }
      const outputBound = Number(requestedOutput);
      const thinking = request.headers["x-pi-thinking-level"];
      const thinkingLevel = typeof thinking === "string" ? thinking : "off";
      const reserved = await options.db.rpc("gateway_reserve_model_request", { user_id_input: verified.data.user.id,
        project_id_input: match[1], profile_id_input: profileId, thinking_level_input: thinkingLevel,
        input_bound_input: INPUT_BOUND, output_bound_input: outputBound });
      if (reserved.error) return respond(response, 403, { error: { message: "Institution model access denied." } });
      const decision = reserved.data as { allowed: boolean; warning: boolean; action?: string; reservationId?: string; provider?: string; providerModel?: string };
      if (!decision.allowed) return respond(response, 429, { error: { message: "The institution model budget or token limit has been reached.", action: decision.action } });
      if (!decision.reservationId || !decision.provider || !decision.providerModel) throw new Error("Invalid reservation response.");
      const upstream = options.providers[decision.provider];
      if (!upstream) return respond(response, 503, { error: { message: "Institution model provider is unavailable." } });
      const base = new URL(upstream.baseUrl);
      if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) throw new Error("Provider endpoint requires HTTPS.");
      const upstreamResponse = await fetchImpl(`${base.toString().replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${upstream.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, model: decision.providerModel, stream: false, stream_options: undefined, max_completion_tokens: undefined, max_tokens: outputBound }),
      });
      if (!upstreamResponse.ok) return respond(response, 502, { error: { message: "Institution model provider failed." } });
      const completion = await upstreamResponse.json() as Record<string, unknown>;
      const usage = usageFromProvider(completion.usage);
      if (!usage || !Array.isArray(completion.choices) || !completion.choices.length) return respond(response, 502, { error: { message: "Provider usage could not be verified." } });
      const settled = await options.db.rpc("gateway_settle_model_request", { reservation_id_input: decision.reservationId, session_id_input: sessionId,
        input_tokens_input: usage.input, output_tokens_input: usage.output, cache_read_tokens_input: usage.cacheRead,
        cache_write_tokens_input: usage.cacheWrite });
      if (settled.error) return respond(response, 503, { error: { message: "Usage settlement failed; request held for review." } });
      if (body.stream) streamCompletion(response, completion, usage);
      else respond(response, 200, completion);
    } catch {
      respond(response, 500, { error: { message: "Institution model request failed." } });
    }
  });
}
