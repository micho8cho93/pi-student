# 0008: Platform administration

## Decision

Platform role is a separate database table, `platform_administrators`, seeded only through trusted SQL for existing profile IDs. No authenticated client receives write privileges to it. Restricted RPCs provide organization creation, status/name updates, administrator appointment, entitlement changes, and aggregate operational counts. The platform app has no service-role credential.

Platform role alone does not satisfy class or session RLS. Aggregate counts come from `platform_organization_summary`, which returns counts only. Operator changes to tenant administrators cannot modify owners or appoint a platform operator to tenant administration. Organization creation cannot name a platform operator as owner. Each organization retains at least one active owner. Tenant owners and admins cannot modify platform data.

An exact-email lookup resolves existing accounts for administrator appointment. It is available only to a platform operator or an authorized tenant administrator for the requested organization; it does not provide a user directory listing. Email delivery and invitations for new accounts are deferred.

## Consequences

Operators can manage tenant configuration without hidden access to student work. Future support access must have an explicit reason, limited duration, narrow scope, and audit trail. No impersonation path is present in Phase 2.
