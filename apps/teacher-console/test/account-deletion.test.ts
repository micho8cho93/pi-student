import { afterEach, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { startTeacherDashboard } from "../src/dashboard-server.js";

const original = {
	url: process.env.PI_STUDENT_SUPABASE_URL,
	key: process.env.PI_STUDENT_SUPABASE_PUBLISHABLE_KEY,
	service: process.env.PI_STUDENT_SUPABASE_SERVICE_ROLE_KEY,
};

afterEach(() => {
	for (const [name, value] of [
		["PI_STUDENT_SUPABASE_URL", original.url],
		["PI_STUDENT_SUPABASE_PUBLISHABLE_KEY", original.key],
		["PI_STUDENT_SUPABASE_SERVICE_ROLE_KEY", original.service],
	] as const) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

it("keeps account deletion behind same-origin, server key, and bearer checks", async () => {
	process.env.PI_STUDENT_SUPABASE_URL = "https://example.test";
	process.env.PI_STUDENT_SUPABASE_PUBLISHABLE_KEY = "public";
	delete process.env.PI_STUDENT_SUPABASE_SERVICE_ROLE_KEY;
	const server = await startTeacherDashboard({ port: 0, open: false });
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	try {
		const options = { method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}" };
		const wrongOrigin = await fetch(`${origin}/api/account/delete`, { ...options, headers: { ...options.headers, origin: "https://elsewhere.test" } });
		expect(wrongOrigin.status).toBe(403);
		const noServiceKey = await fetch(`${origin}/api/account/delete`, options);
		expect(noServiceKey.status).toBe(503);
		process.env.PI_STUDENT_SUPABASE_SERVICE_ROLE_KEY = "server-test-key";
		const noBearer = await fetch(`${origin}/api/account/delete`, options);
		expect(noBearer.status).toBe(401);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
