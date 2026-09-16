import { describe, expect, it, vi } from "vitest";
import { canUseOrganizationFeature, type OrganizationAuthorization, type OrganizationEntitlements } from "../src/index.js";

describe("organization feature access", () => {
	it("requires user authorization and a product grant independently", async () => {
		const authorization = { can: vi.fn().mockResolvedValue(false) } as unknown as OrganizationAuthorization;
		const entitlements = { has: vi.fn().mockResolvedValue(true) } as unknown as OrganizationEntitlements;
		expect(await canUseOrganizationFeature(authorization, entitlements, "org-a", "manage", "organization_admin")).toBe(false);
		expect(entitlements.has).not.toHaveBeenCalled();
		vi.mocked(authorization.can).mockResolvedValue(true);
		vi.mocked(entitlements.has).mockResolvedValue(false);
		expect(await canUseOrganizationFeature(authorization, entitlements, "org-a", "manage", "organization_admin")).toBe(false);
		vi.mocked(entitlements.has).mockResolvedValue(true);
		expect(await canUseOrganizationFeature(authorization, entitlements, "org-a", "manage", "organization_admin")).toBe(true);
	});
});
