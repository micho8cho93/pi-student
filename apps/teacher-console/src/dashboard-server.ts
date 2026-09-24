import { createServer, type Server } from "node:http";
import process from "node:process";
import { dashboardPage } from "./dashboard-page.js";
import { readSupabaseConfig } from "@pi-student/supabase-adapter/config";
import { openBrowser } from "./open-browser.js";
import { handleTeacherAccountDeletion } from "./account-deletion.js";
import type { AddressInfo } from "node:net";

export interface DashboardServerOptions { port?: number; open?: boolean }

export async function startTeacherDashboard(options: DashboardServerOptions = {}): Promise<Server> {
	const config = readSupabaseConfig();
	if (!config) throw new Error("Set PI_STUDENT_SUPABASE_URL and PI_STUDENT_SUPABASE_PUBLISHABLE_KEY before starting the dashboard.");
	let serverOrigin = "";
	const server = createServer((request, response) => {
		const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		if (requestPath === "/api/account/delete" && request.method === "POST") {
			void handleTeacherAccountDeletion(request, response, config, serverOrigin);
			return;
		}
		if (requestPath !== "/" && requestPath !== "/index.html" && requestPath !== "/auth/callback") {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			response.end("Not found");
			return;
		}
		response.writeHead(200, {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' https://*.supabase.co wss://*.supabase.co; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
		});
		response.end(dashboardPage(config));
	});
	const port = options.port ?? 4173;
	await new Promise<void>((resolve, reject) => server.listen(port, "127.0.0.1", resolve).once("error", reject));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	serverOrigin = url;
	process.stdout.write(`Teacher dashboard: ${url}\nPress Ctrl+C to stop.\n`);
	if (options.open !== false) openBrowser(url);
	return server;
}
