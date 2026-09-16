import { describe, expect, it } from "vitest";
import { membershipCan, type OrganizationMembership, type OrganizationRole } from "../src/index.js";

const membership = (role: OrganizationRole, status: OrganizationMembership["status"] = "active"): OrganizationMembership => ({
	organizationId: "org-a", userId: "user-a", role, status,
});

describe("organization capabilities", () => {
	it("keeps tenant roles separate from class participation", () => {
		expect(membershipCan(membership("teacher"), "create_class")).toBe(true);
		expect(membershipCan(membership("teacher"), "manage")).toBe(false);
		expect(membershipCan(membership("member"), "create_class")).toBe(false);
		expect(membershipCan(membership("admin"), "manage_members")).toBe(true);
	});
	it("suspension or absence revokes every capability", () => {
		expect(membershipCan(membership("owner", "suspended"), "view")).toBe(false);
		expect(membershipCan(undefined, "view")).toBe(false);
	});
});
