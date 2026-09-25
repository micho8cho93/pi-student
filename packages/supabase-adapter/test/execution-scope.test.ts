import { describe, expect, it, vi } from "vitest";
import { SupabaseExecutionScopeProvider } from "../src/execution-scope.js";

function client(options: { organizationId?: string; member?: boolean; missingClass?: boolean; rpcOrganizationId?: string; rpcClassId?: string } = {}) {
	const organizationId = options.organizationId ?? "org-a";
	const rpc = vi.fn(async () => ({ data: { organizationId: options.rpcOrganizationId ?? organizationId,
		classId: options.rpcClassId ?? "class-a" }, error: null }));
	return { auth: { getUser: async () => ({ data: { user: { id: "student-a" } }, error: null }) },
		from: (table: string) => ({ select: () => ({ eq: () => ({
			maybeSingle: async () => table === "projects"
				? { data: { class_id: "class-a", classes: options.missingClass ? null : { organization_id: organizationId } }, error: null }
				: { data: options.member === false ? null : { status: "active" }, error: null },
			eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: options.member === false ? null : { status: "active" }, error: null }) }) }),
		}) }) }), rpc };
}

describe("Supabase execution scope adapter", () => {
	it("derives the authoritative tenant and student from existing relationships", async () => {
		const database = client();
		expect(await new SupabaseExecutionScopeProvider(database as never).resolve("project-a"))
			.toEqual({ projectId: "project-a", classId: "class-a", organizationId: "org-a", userId: "student-a" });
		expect(database.rpc).toHaveBeenCalledWith("governance_context", { project_id_input: "project-a" });
	});
	it("denies inactive membership and cross-organization RPC data", async () => {
		await expect(new SupabaseExecutionScopeProvider(client({ member: false }) as never).resolve("project-a")).rejects.toThrow("Active class membership");
		await expect(new SupabaseExecutionScopeProvider(client({ rpcOrganizationId: "org-b" }) as never).resolve("project-a")).rejects.toThrow("scope");
		await expect(new SupabaseExecutionScopeProvider(client({ rpcClassId: "class-b" }) as never).resolve("project-a")).rejects.toThrow("scope");
		await expect(new SupabaseExecutionScopeProvider(client({ missingClass: true }) as never).resolve("project-a")).rejects.toThrow("class scope");
	});
});
