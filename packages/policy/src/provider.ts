import type { EffectivePolicy, PolicyContext, PolicyProvider } from "@pi-student/contracts";

export class StaticPolicyProvider implements PolicyProvider {
	constructor(private readonly policy?: EffectivePolicy) {}
	async resolvePolicy(_context: PolicyContext): Promise<EffectivePolicy | undefined> { return this.policy; }
}

/** Adapts an existing context store without making policy depend on its persistence backend. */
export class StoredPolicyProvider implements PolicyProvider {
	constructor(private readonly load: () => Promise<{ policy?: EffectivePolicy }>) {}
	async resolvePolicy(_context: PolicyContext): Promise<EffectivePolicy | undefined> { return (await this.load()).policy; }
}
