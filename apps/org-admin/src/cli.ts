#!/usr/bin/env node
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { supportedThinkingLevels } from "@pi-student/policy/thinking";
import { callCatalogMcp } from "@pi-student/shared/catalog-mcp";
import { mcpCatalog } from "@pi-student/shared/extension-catalog";
import { createServer } from "node:http";
import { readSupabaseConfig } from "@pi-student/supabase-adapter/config";
import { dashboardPage } from "@pi-student/classroom-ui/dashboard-page";
import { orgAdminPage } from "./page.js";

const config = readSupabaseConfig();
if (!config) throw new Error("Set PI_STUDENT_SUPABASE_URL and PI_STUDENT_SUPABASE_PUBLISHABLE_KEY.");
const port = Number(process.env.PI_STUDENT_ORG_ADMIN_PORT ?? 4174);
const host = process.env.PI_STUDENT_ORG_ADMIN_HOST ?? "127.0.0.1";
const modelCatalog=ModelRuntime.create({modelsPath:null,refreshOnCreate:false}).then(runtime=>runtime.getModels().filter(m=>m.api==='openai-completions').map(m=>({id:m.id,name:m.name,provider:m.provider,levels:supportedThinkingLevels(m),cost:m.cost})));
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if(path==='/api/catalog/models'&&request.method==='GET'){void modelCatalog.then(models=>response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(models))).catch(()=>response.writeHead(503).end());return;}
  if(path==='/api/catalog/check-mcp'&&request.method==='POST'){
    if(request.headers.origin!==`http://${host}:${port}`){response.writeHead(403).end();return;}
    void callCatalogMcp(mcpCatalog[0]!.endpoint,'tools/list').then(()=>response.writeHead(200,{'content-type':'application/json'}).end('{"connected":true}')).catch(()=>response.writeHead(502).end());return;
  }
  if (!["/", "/auth/callback", "/class"].includes(path)) { response.writeHead(404).end(); return; }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ${new URL(config.url).origin}; style-src 'self' 'unsafe-inline'; img-src 'self' data:`,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  });
  response.end(path === "/class" ? dashboardPage(config, true) : orgAdminPage(config));
});
server.listen(port, host, () => process.stdout.write(`Organization administration: http://${host}:${port}\n`));
