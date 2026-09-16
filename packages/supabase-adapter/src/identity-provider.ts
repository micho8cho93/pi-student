import type { IdentityContext, IdentityKind, IdentityProvider } from "@pi-student/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

export class SupabaseIdentityProvider implements IdentityProvider {
	constructor(private readonly client: SupabaseClient, private readonly signedInKind: Extract<IdentityKind, "student" | "teacher"> = "student") {}
	async getIdentity(): Promise<IdentityContext> {
		const { data, error } = await this.client.auth.getUser();
		if (error && !/session missing|auth session missing/i.test(error.message)) throw error;
		if (!data.user) return { kind: "personal" };
		return { kind: this.signedInKind, userId: data.user.id, email: data.user.email };
	}
}
