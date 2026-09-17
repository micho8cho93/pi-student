import { expect, it, vi } from "vitest";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DirectModelProvider } from "../src/model-provider.js";

it("registers approved institution profiles against the gateway with a student token", async () => {
	const registerProvider = vi.fn();
	const provider = await DirectModelProvider.create({ registerProvider } as unknown as ModelRuntime);
	provider.configureHostedProfiles("74000000-0000-0000-0000-000000000001", "https://models.example.test", [{
		id: "75000000-0000-0000-0000-000000000001", organizationId: "72000000-0000-0000-0000-000000000001",
		displayName: "General Coding", provider: "openai", providerModel: "gpt-test", allowedThinkingLevels: ["off", "low"], available: true, version: 1,
	}], "student-jwt");
	expect(registerProvider).toHaveBeenCalledWith("institution", expect.objectContaining({
		api: "openai-completions", baseUrl: "https://models.example.test/projects/74000000-0000-0000-0000-000000000001/v1",
		apiKey: "student-jwt", models: [expect.objectContaining({ id: "75000000-0000-0000-0000-000000000001" })],
	}));
	provider.refreshHostedToken("new-student-jwt", "77000000-0000-0000-0000-000000000001", "low");
	expect(registerProvider).toHaveBeenLastCalledWith("institution", expect.objectContaining({
		apiKey: "new-student-jwt", headers: { "X-Pi-Session-Id": "77000000-0000-0000-0000-000000000001", "X-Pi-Thinking-Level": "low" },
	}));
});
