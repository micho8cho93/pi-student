# 0007: Organization entitlements

## Decision

Role authorization asks whether the signed-in person may perform an action in a tenant. `organization_entitlements` asks whether that tenant has a product capability. `@pi-student/organization` defines `OrganizationEntitlements` and a combined resolver that requires both answers. The Supabase adapter calls `organization_has_entitlement`, which checks the authenticated subject. There are no plan-name checks in application code.

New organizations receive `organization_admin` by default. Only platform operators can change grants via `set_organization_entitlement`. Disabling `organization_admin` immediately blocks the organization administration UI, organization update policy, and membership mutation trigger. Capability keys for future products are schema placeholders, not implemented features.

## Consequences

Changing commercial plans can map to capability grants without changing authorization roles. Tenant admins cannot self-grant. A platform operator may restore a disabled grant. Suspended organizations lose active role resolution even if their grant remains enabled.
