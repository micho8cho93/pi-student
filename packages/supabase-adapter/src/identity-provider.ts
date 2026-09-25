import type { IdentityContext, IdentityKind, IdentityProvider } from "@pi-student/contracts";
import { createAuthLifecycle, type AuthClientLike } from "@pi-student/shared/auth-lifecycle";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Runtime identity is derived only from an identity the auth backend has just
 * confirmed. A missing, expired or unrefreshable session yields `personal`
 * (so class-scoped work fails closed and the sign-in prompt appears) instead of
 * surfacing a raw token error or trusting stale local storage. Failures that
 * are not about the session (for example a network outage) still throw.
 */
export class SupabaseIdentityProvider implements IdentityProvider {
	constructor(private readonly client: SupabaseClient, private readonly signedInKind: Extract<IdentityKind, "student" | "teacher"> = "student") {}
	async getIdentity(): Promise<IdentityContext> {
		const state = await createAuthLifecycle({ client: this.client as unknown as AuthClientLike }).resolve();
		if (state.status === "authenticated" && state.user) return { kind: this.signedInKind, userId: state.user.id, email: state.user.email ?? undefined };
		if (state.status === "logged_out" && state.reason) throw new Error(state.message ?? "Sign-in could not be verified.");
		return { kind: "personal" };
	}
}
