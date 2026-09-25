import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createApprovedExtensions } from "../src/approved-extensions.js";
import { impeccableFiles } from "@pi-student/shared/impeccable-bundle";
import { mcpCatalog, skillCatalog } from "@pi-student/shared/extension-catalog";
import { DEFAULT_CAPABILITY_POLICY } from "@pi-student/policy/capability-policy";
import type { ExecutionContext, McpDescriptor, SkillDescriptor } from "@pi-student/contracts";

const skill: SkillDescriptor = {
	id: "skill-1", name: "Impeccable", organizationId: "org-1", classId: "class-1", projectId: "project-1",
	scope: "project", enabled: true, approvalStatus: "approved", capabilities: [], artifactDigest: skillCatalog[0]!.artifactDigest,
};
const mcp: McpDescriptor = {
	id: "mcp-1", name: "Cloudflare Documentation", organizationId: "org-1", classId: "class-1", projectId: "project-1",
	scope: "project", enabled: true, approvalStatus: "approved", capabilities: ["network"], transport: "http",
	endpoint: mcpCatalog[0]!.endpoint, allowedHosts: [...mcpCatalog[0]!.hosts],
};

function context(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
	const base: ExecutionContext = {
		identity: { kind: "student", userId: "student-1", organizationId: "org-1", classId: "class-1", projectId: "project-1" },
		workspacePath: "/tmp/pi-student-test", organizationId: "org-1", classId: "class-1", projectId: "project-1",
		policy: { projectId: "project-1", version: 1, settings: { ...DEFAULT_CAPABILITY_POLICY } },
		sandbox: { mode: "gondolin", internetAllowed: true },
		environment: { status: "active", provider: "gondolin", capabilities: { provider: "gondolin", mode: "gondolin", capabilities: ["workspace", "internet-policy"] }, requiredCapabilities: ["workspace", "internet-policy"] },
		skills: [structuredClone(skill)], mcps: [structuredClone(mcp)],
	};
	return { ...base, ...overrides, identity: { ...base.identity, ...overrides.identity }, policy: overrides.policy ?? base.policy,
		sandbox: overrides.sandbox ?? base.sandbox, environment: overrides.environment ?? base.environment,
		skills: overrides.skills ?? base.skills, mcps: overrides.mcps ?? base.mcps };
}

function toolsFor(current: () => ExecutionContext) {
	const tools: any[] = [];
	const telemetry = { record: vi.fn(async () => {}) };
	createApprovedExtensions({ executionContext: async () => current(), telemetrySink: telemetry as never }, () => "implement")({ registerTool: (tool: any) => tools.push(tool) } as any);
	return { tools, telemetry };
}

it("pins the shipped Impeccable bundle and rechecks approval at read time", async () => {
	expect("sha256:" + createHash("sha256").update(JSON.stringify(impeccableFiles)).digest("hex")).toBe(skillCatalog[0]!.artifactDigest);
	let current = context();
	const { tools } = toolsFor(() => current);
	const read = tools.find(tool => tool.name === "school_skill").execute;
	expect((await read("1", { action: "read" })).content[0].text).toContain("name: impeccable");
	current = context({ skills: [{ ...skill, enabled: false }] });
	await expect(read("2", { action: "read" })).rejects.toThrow("unavailable");
});

it("fails closed for disabled, rejected, cross-project, cross-organization, and invalid environments", async () => {
	let current = context({ skills: [{ ...skill, enabled: false }], mcps: [] });
	const { tools } = toolsFor(() => current);
	const skillTool = tools.find(tool => tool.name === "school_skill").execute;
	expect((await skillTool("1", { action: "list" })).content[0].text).toBe("[]");
	current = context({ skills: [{ ...skill, approvalStatus: "rejected" }] });
	expect((await skillTool("2", { action: "list" })).content[0].text).toBe("[]");
	current = context({ skills: [{ ...skill, projectId: "other-project" }] });
	expect((await skillTool("3", { action: "list" })).content[0].text).toBe("[]");
	current = context({ skills: [{ ...skill, organizationId: "other-org" }] });
	expect((await skillTool("4", { action: "list" })).content[0].text).toBe("[]");
	current = context({ environment: { ...context().environment!, status: "failed" } });
	expect((await skillTool("5", { action: "list" })).content[0].text).toBe("[]");
});

it("requires the current sandbox capability and curated host before an MCP call", async () => {
	let current = context({ environment: { ...context().environment!, capabilities: { provider: "gondolin", mode: "gondolin", capabilities: ["workspace"] } } });
	const { tools } = toolsFor(() => current);
	const mcpTool = tools.find(tool => tool.name === "school_mcp").execute;
	await expect(mcpTool("1", { action: "call", connectorId: mcpCatalog[0]!.id, tool: "search" })).rejects.toThrow("unavailable");
	current = context({ mcps: [{ ...mcp, endpoint: "https://internal.example/mcp", allowedHosts: ["internal.example"] }] });
	await expect(mcpTool("2", { action: "call", connectorId: "internal", tool: "anything" })).rejects.toThrow("unavailable");
});

it("does not connect to arbitrary registered endpoints", async () => {
	const network = vi.spyOn(globalThis, "fetch");
	const current = context({ mcps: [{ ...mcp, id: "untrusted", name: "Other", endpoint: "https://internal.example/mcp", allowedHosts: ["internal.example"] }] });
	const { tools } = toolsFor(() => current);
	await expect(tools.find(tool => tool.name === "school_mcp").execute("1", { action: "call", connectorId: "untrusted", tool: "anything" })).rejects.toThrow("unavailable");
	expect(network).not.toHaveBeenCalled();
	network.mockRestore();
});
