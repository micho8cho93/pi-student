import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { impeccableFiles } from "@pi-student/shared/impeccable-bundle";
import { mcpCatalog, skillCatalog } from "@pi-student/shared/extension-catalog";
import { callCatalogMcp } from "@pi-student/shared/catalog-mcp";
import { callPersonalSupabaseMcp, supabaseMcpConnected } from "@pi-student/shared/supabase-mcp-oauth";
import type { McpDescriptor, ExecutionContext, SkillDescriptor } from "@pi-student/contracts";
import { authorizeExtension } from "./extension-authorization.js";
import type { StudentRuntimeServices } from "./telemetry-integration.js";

const skill = skillCatalog[0]!;

/** Registers stable names while every discovery and execution uses a fresh control-plane snapshot. */
export function createApprovedExtensions(services: StudentRuntimeServices = {}, stage: () => string = () => ""): ExtensionFactory {
	return pi => {
		const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
		const audit = async (context: ExecutionContext | undefined, action: "skill.list" | "skill.read" | "mcp.list" | "mcp.call", decision: "allowed" | "denied", reasonCode: string, extension?: SkillDescriptor | McpDescriptor, capability?: string) => {
			if (!context?.organizationId || !context.classId || !context.projectId || !services.telemetrySink) return;
			try {
				await services.telemetrySink.record({ type: "execution-decision", eventId: randomUUID(), organizationId: context.organizationId, classId: context.classId, projectId: context.projectId, sessionId: context.sessionId, action, decision, extensionId: extension?.id, capability, stage: stage() || undefined, reasonCode, environmentProvider: context.environment?.provider, environmentStatus: context.environment?.status });
			} catch {
				// Telemetry cannot replace the control-plane decision or reveal its details.
			}
		};
		const resolve = async (): Promise<{ context?: ExecutionContext; environment?: { sandbox: ExecutionContext["sandbox"]; skills?: SkillDescriptor[]; mcps?: McpDescriptor[] } }> => {
			if (services.executionContext) {
				const context = await services.executionContext();
				return { context, environment: context };
			}
			// Legacy callers have no authoritative scope. Keep discovery inert and
			// require the execution-context path for any actual extension access.
			return { environment: await services.extensionEnvironment?.() };
		};
		const deny = async (context: ExecutionContext | undefined, action: "skill.list" | "skill.read" | "mcp.list" | "mcp.call", reasonCode: string, extension?: SkillDescriptor | McpDescriptor) => {
			await audit(context, action, "denied", reasonCode, extension);
			throw new Error("This school extension is unavailable for the current project.");
		};

		pi.registerTool({
			name: "school_skill",
			label: "School skill",
			description: "Read an organization-approved skill. Approval, scope, capability, workflow, and environment are rechecked immediately before access.",
			parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("read")]), resource: Type.Optional(Type.String()) }),
			async execute(_id, params) {
				const { context, environment } = await resolve();
				const available = (environment?.skills ?? []).filter(item => item.artifactDigest === skill.artifactDigest);
				const authorized = context ? available.filter(item => authorizeExtension(context, item, "skill", params.action, stage()).allowed) : [];
				if (params.action === "list") {
					if (!authorized.length) { await audit(context, "skill.list", "denied", "extension-not-approved", available[0]); return result("[]"); }
					await audit(context, "skill.list", "allowed", "authorized", authorized[0]);
					return result(JSON.stringify(authorized.map(item => ({ id: item.id, name: item.name, version: item.version, resources: Object.keys(impeccableFiles) }))));
				}
				const selected = authorized[0];
				if (!selected) return deny(context, "skill.read", "extension-not-approved", available[0]);
				const resource = params.resource || "SKILL.md";
				if (!Object.hasOwn(impeccableFiles, resource)) return deny(context, "skill.read", "resource-not-allowlisted", selected);
				await audit(context, "skill.read", "allowed", "authorized", selected);
				return result("School-approved Markdown guidance. External launchers are unavailable; use the documented fallback and existing sandbox tools. Organization capabilities remain authoritative.\n\n" + impeccableFiles[resource]);
			},
		});

		pi.registerTool({
			name: "school_mcp",
			label: "School connector",
			description: "Use an approved school connector. Curated host selection is runtime-owned; host-managed credentials stay outside the model and sandbox.",
			parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("call")]), connectorId: Type.Optional(Type.String()), tool: Type.Optional(Type.String()), arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())) }),
			async execute(_id, params) {
				const { context, environment } = await resolve();
				const available = (environment?.mcps ?? []).map(item => ({ item, catalog: mcpCatalog.find(entry => entry.endpoint === item.endpoint) })).filter(pair => pair.catalog);
				const authorized = context ? available.filter(({ item, catalog }) => authorizeExtension(context, item, "mcp", params.action, stage(), catalog).allowed) : [];
				if (params.action === "list") {
					if (!authorized.length) { await audit(context, "mcp.list", "denied", "extension-not-approved", available[0]?.item); return result("[]"); }
					const listed: unknown[] = [];
					for (const { item, catalog } of authorized) {
						if (catalog!.id === "supabase") {
							const userId = context?.identity.userId;
							if (!userId || !await supabaseMcpConnected(userId)) { listed.push({ id: catalog!.id, name: item.name, connected: false, tools: [] }); continue; }
						}
						const inventory = await connect(catalog!.id, catalog!.endpoint, context?.identity.userId, "tools/list");
						const safeInventory = sanitizeConnectorPayload(inventory);
						listed.push({ id: catalog!.id, name: item.name, connected: true,
							...(safeInventory && typeof safeInventory === "object" && !Array.isArray(safeInventory) ? safeInventory : { payload: safeInventory }) });
					}
					await audit(context, "mcp.list", "allowed", "authorized", authorized[0]?.item);
					return result(JSON.stringify(listed));
				}

				const selected = authorized.find(({ catalog }) => catalog!.id === params.connectorId);
				if (!selected) return deny(context, "mcp.call", "connector-not-authorized", available.find(({ catalog }) => catalog?.id === params.connectorId)?.item);
				if (!params.tool || params.tool.length > 160 || !/^[a-zA-Z0-9_.:-]+$/u.test(params.tool)) return deny(context, "mcp.call", "tool-name-invalid", selected.item);
				const inventory = await connect(selected.catalog!.id, selected.catalog!.endpoint, context?.identity.userId, "tools/list");
				if (!Array.isArray(inventory?.tools) || !inventory.tools.some((entry: unknown) => entry && typeof entry === "object" && (entry as { name?: unknown }).name === params.tool)) return deny(context, "mcp.call", "tool-not-allowlisted", selected.item);
				const payload = await connect(selected.catalog!.id, selected.catalog!.endpoint, context?.identity.userId, "tools/call", { name: params.tool, arguments: params.arguments ?? {} });
				await audit(context, "mcp.call", "allowed", "authorized", selected.item);
				return result(JSON.stringify(sanitizeConnectorPayload(payload)));
			},
		});

		async function connect(id: string, endpoint: string | undefined, userId: string | undefined, method: "tools/list" | "tools/call", params: Record<string, unknown> = {}) {
			if (id === "supabase") {
				if (!userId) throw new Error("Sign in to Pi Student before connecting Supabase.");
				return callPersonalSupabaseMcp(userId, method, params);
			}
			if (!endpoint) throw new Error("Connector endpoint is unavailable.");
			return callCatalogMcp(endpoint, method, params);
		}
	};
}

function sanitizeConnectorPayload(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeConnectorPayload);
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (/secret|token|password|api[_-]?key|authorization|credential|private[_-]?key/i.test(key)) output[key] = "[redacted]";
		else output[key] = sanitizeConnectorPayload(child);
	}
	return output;
}
