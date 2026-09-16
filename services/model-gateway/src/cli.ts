import { createClient } from "@supabase/supabase-js";
import { createModelGateway, type UpstreamProvider } from "./index.js";

const supabaseUrl = process.env.PI_STUDENT_SUPABASE_URL;
const serviceKey = process.env.PI_STUDENT_SUPABASE_SERVICE_ROLE_KEY;
const providerJson = process.env.PI_STUDENT_GATEWAY_PROVIDERS;
if (!supabaseUrl || !serviceKey || !providerJson) throw new Error("Gateway server configuration is incomplete.");
const providers = JSON.parse(providerJson) as Record<string, UpstreamProvider>;
for (const provider of Object.values(providers)) {
  if (!provider.apiKey || !provider.baseUrl) throw new Error("Gateway provider configuration is incomplete.");
}
const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const port = Number(process.env.PI_STUDENT_GATEWAY_PORT ?? 4176);
const host = process.env.PI_STUDENT_GATEWAY_HOST ?? "127.0.0.1";
createModelGateway({ db, providers }).listen(port, host, () => process.stdout.write(`Model gateway listening on ${host}:${port}\n`));
