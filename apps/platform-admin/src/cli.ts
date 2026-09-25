#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readSupabaseConfig } from "@pi-student/supabase-adapter/config";
import { platformAdminPage } from "./page.js";

const config = readSupabaseConfig();
if (!config) throw new Error("Set PI_STUDENT_SUPABASE_URL and PI_STUDENT_SUPABASE_PUBLISHABLE_KEY.");
const port = Number(process.env.PI_STUDENT_PLATFORM_ADMIN_PORT ?? 4175);
const host = process.env.PI_STUDENT_PLATFORM_ADMIN_HOST ?? "127.0.0.1";
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/supabase-browser.js") {
    void readFile(new URL("./supabase-browser.js", import.meta.url)).then(bundle => response.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'none'; script-src 'self'", "x-content-type-options": "nosniff",
    }).end(bundle)).catch(() => response.writeHead(404).end());
    return;
  }
  if (!["/", "/auth/callback"].includes(path)) { response.writeHead(404).end(); return; }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ${new URL(config.url).origin}; style-src 'self' 'unsafe-inline'; img-src 'self' data:`,
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  });
  response.end(platformAdminPage(config));
});
server.listen(port, host, () => process.stdout.write(`Platform administration: http://${host}:${port}\n`));
