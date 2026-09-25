import { expect, it, vi } from "vitest";
import { SupabaseOrganizationAuthorization } from "../src/organization-authorization.js";

function client() {
	return {
		rpc: vi.fn(async () => ({ data: null as unknown, error: null as Error | null })),
		auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } }, error: null })) },
	};
}

it("routes ownership and complete teacher assignment commands through authoritative RPCs", async () => {
	const db = client();
	const authorization = new SupabaseOrganizationAuthorization(db as never);

	await authorization.transferOwnership("org-1", "user-2");
	await authorization.setClassTeacherAssignments("class-1", ["teacher-1", "teacher-2"]);

	expect(db.rpc).toHaveBeenNthCalledWith(1, "transfer_organization_ownership", {
		organization_id_input: "org-1", target_user_id_input: "user-2",
	});
	expect(db.rpc).toHaveBeenNthCalledWith(2, "set_class_teacher_assignments", {
		class_id_input: "class-1", teacher_ids_input: ["teacher-1", "teacher-2"],
	});
});

it("does not swallow authoritative RPC failures", async () => {
	const db = client();
	db.rpc.mockResolvedValueOnce({ data: null, error: new Error("ownership rejected") });
	await expect(new SupabaseOrganizationAuthorization(db as never).transferOwnership("org-1", "user-2"))
		.rejects.toThrow("ownership rejected");
});
