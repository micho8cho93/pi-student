import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deviceCode, verifyGitHubDownload } from "../publishing/github-runtime.js";
import { GhGitHubClient } from "../publishing/github-client.js";

describe("browser GitHub connection", () => {
	it("extracts only the one-time device code for the UI", () => {
		expect(deviceCode("! First copy your one-time code: ABCD-1234\nOpen this URL to continue" )).toBe("ABCD-1234");
		expect(deviceCode("! First copy your one-time code: ABCD-")).toBeUndefined();
		expect(deviceCode("ghp_sensitive_token")).toBeUndefined();
	});
	it("rejects a modified helper download before execution", () => {
		const bytes = Buffer.from("official release");
		const digest = createHash("sha256").update(bytes).digest("hex");
		expect(() => verifyGitHubDownload(bytes, digest)).not.toThrow();
		expect(() => verifyGitHubDownload(Buffer.from("modified release"), digest)).toThrow("checksum");
	});
	it("configures Git credentials and verifies the account after browser authorization", async () => {
		const calls: string[][] = [];
		const client = new GhGitHubClient(async args => {
			calls.push(args);
			return args[0] === "api" ? JSON.stringify({ login: "student" }) : "";
		});
		expect(await client.connect()).toEqual({ connected: true, username: "student" });
		expect(calls[0]).toContain("--web");
		expect(calls[1]).toEqual(["auth", "setup-git", "--hostname", "github.com"]);
		expect(calls[2].slice(0, 2)).toEqual(["api", "/user"]);
	});
});
