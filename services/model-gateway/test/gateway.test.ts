import { afterEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createModelGateway } from "../src/index.js";
import type { AddressInfo } from "node:net";

const projectId = "74000000-0000-0000-0000-000000000001";
const profileId = "75000000-0000-0000-0000-000000000001";
const sessionId = "77000000-0000-0000-0000-000000000001";
const servers: ReturnType<typeof createModelGateway>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

async function request(allowed = true, token = "student-jwt", options: Record<string, unknown> = {}, action = "block_ai") {
  const rpc = vi.fn(async (name: string) => name === "gateway_reserve_model_request" ? {
    data: allowed ? { allowed: true, warning: false, reservationId: "78000000-0000-0000-0000-000000000001", provider: "openai", providerModel: "gpt-test" } :
      { allowed: false, warning: true, action }, error: null,
  } : { data: null, error: null });
  const db = { auth: { getUser: vi.fn(async (jwt: string) => jwt === "student-jwt" ? { data: { user: { id: "student-1" } }, error: null } : { data: { user: null }, error: new Error("expired") }) }, rpc } as unknown as Pick<SupabaseClient, "auth" | "rpc">;
  const upstream = vi.fn(async () => new Response(JSON.stringify({ id: "reply-1", created: 1, model: "gpt-test",
    choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 30, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 10 } } }), { status: 200 }));
  const server = createModelGateway({ db, providers: { openai: { baseUrl: "https://api.example.test/v1", apiKey: "server-secret" } }, fetchImpl: upstream as typeof fetch });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/projects/${projectId}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-pi-session-id": sessionId, "x-pi-thinking-level": "low" },
    body: JSON.stringify({ model: profileId, messages: [{ role: "user", content: "Hi" }], stream: true, ...options }),
  });
  return { response, rpc, upstream };
}

it("verifies identity, reserves a worst-case request, settles provider usage, and streams the result", async () => {
  const { response, rpc, upstream } = await request();
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("data: [DONE]");
  expect(rpc).toHaveBeenCalledWith("gateway_reserve_model_request", expect.objectContaining({ user_id_input: "student-1", project_id_input: projectId, profile_id_input: profileId, input_bound_input: 32000, output_bound_input: 4096 }));
  expect(rpc).toHaveBeenCalledWith("gateway_settle_model_request", expect.objectContaining({ input_tokens_input: 20, output_tokens_input: 5, cache_read_tokens_input: 10, session_id_input: sessionId }));
  expect(upstream).toHaveBeenCalledOnce();
  const upstreamArgs = upstream.mock.calls[0] as unknown as [string, RequestInit];
  expect(upstreamArgs[0]).toBe("https://api.example.test/v1/chat/completions");
  expect((upstreamArgs[1].headers as Record<string, string>).authorization).toBe("Bearer server-secret");
});

it("blocks at the hard limit before contacting the provider", async () => {
  const { response, rpc, upstream } = await request(false);
  expect(response.status).toBe(429);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(upstream).not.toHaveBeenCalled();
});

it("reserves and forwards a shorter output limit for inline completion", async () => {
  const { response, rpc, upstream } = await request(true, "student-jwt", { max_tokens: 160 });
  expect(response.status).toBe(200);
  await response.text();
  expect(rpc).toHaveBeenCalledWith("gateway_reserve_model_request", expect.objectContaining({ output_bound_input: 160 }));
  const upstreamArgs = upstream.mock.calls[0] as unknown as [string, RequestInit];
  expect(JSON.parse(String(upstreamArgs[1].body)).max_tokens).toBe(160);
  const modern = await request(true, "student-jwt", { max_completion_tokens: 160 });
  expect(modern.response.status).toBe(200);
  await modern.response.text();
  expect(modern.rpc).toHaveBeenCalledWith("gateway_reserve_model_request", expect.objectContaining({ output_bound_input: 160 }));
});

it("classifies tool-using requests as agent work for the tutoring reserve", async () => {
  const tutoring = await request();
  await tutoring.response.text();
  expect(tutoring.rpc).toHaveBeenCalledWith("gateway_reserve_model_request", expect.objectContaining({ agent_request_input: false }));
  const agent = await request(true, "student-jwt", { tools: [{ type: "function", function: { name: "edit", parameters: {} } }] });
  await agent.response.text();
  expect(agent.rpc).toHaveBeenCalledWith("gateway_reserve_model_request", expect.objectContaining({ agent_request_input: true }));
});

it("explains that tutoring continues when only the agent lane is closed", async () => {
  const { response, upstream } = await request(false, "student-jwt", { tools: [{ type: "function", function: { name: "edit", parameters: {} } }] }, "assistance_only");
  expect(response.status).toBe(429);
  expect((await response.json() as { error: { message: string; action: string } }).error).toMatchObject({ action: "assistance_only", message: expect.stringContaining("Tutoring") });
  expect(upstream).not.toHaveBeenCalled();
});

it("rejects an expired student token before a budget reservation", async () => {
  const { response, rpc, upstream } = await request(true, "expired");
  expect(response.status).toBe(401);
  expect(rpc).not.toHaveBeenCalled();
  expect(upstream).not.toHaveBeenCalled();
});
