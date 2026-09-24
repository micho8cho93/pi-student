# Organization foundation status

Phase 1 establishes organization tenancy without changing the student runtime. Phase 2 adds the two administration applications, entitlements, platform operations, and audit events. Phase 3 adds policy resolution, institution models, a trusted model gateway, usage metering, and budgets; see ADRs 0010 and 0011.

## Implemented

- `@pi-student/organization` defines organization and membership DTOs, tenant roles, capabilities, and provider-neutral authorization and administration interfaces. `PlatformRole` is distinct from classroom and organization roles.
- `@pi-student/sdk/organization` is the stable application import. `SupabaseOrganizationAuthorization` implements it in the concrete adapter.
- The migration creates `organizations`, `organization_memberships`, and nullable `classes.organization_id`, plus indexes, grants, RLS policies, and restricted RPCs for creation and membership changes.
- Managed class access uses active organization membership and, for teachers, active class teacher membership. Organization owner/admin capabilities are scoped to one tenant. Students use class membership and do not gain organization administration rights.
- Existing classes remain standalone with `organization_id = NULL`; existing teacher and student flows remain valid. No synthetic organizations or automatic reassignment are introduced.
- pgTAP tests cover cross-tenant data, role escalation, class and project scope, student access, unauthenticated access, spoofed organization IDs, last-owner protection, and immediate revocation after removal.

## Authorization map

| Role or situation | Organization | Managed classes | Standalone classes |
| --- | --- | --- | --- |
| Owner/admin, active | Manage own tenant and memberships | Manage classes in own tenant | No implicit access |
| Teacher, active | View tenant; create class | Manage assigned teacher classes only | Existing creator/teacher membership rules |
| Member, active | View tenant | No implicit access | No implicit access |
| Student with active class membership | No tenant administration needed | Read class learning resources; write own session | Same classroom behavior |
| Personal user | None required | None required | Local Pi Student remains available |

Removing an organization membership revokes managed teacher/admin access. Removing the last active owner is rejected. Class sessions cannot be moved between students or classes with a client update. A student may retain access to their own historical session under the existing self-access policy after class membership changes; teacher access to that student's session requires current active class membership.

## Phase 2 administration

- `apps/org-admin` handles institution roster, class creation and teacher association, organization name, entitlement visibility, and audit history. Only active owners/admins of the selected organization can use it while `organization_admin` is enabled. Existing accounts can be found by exact email; invitation delivery for accounts that do not yet exist is deferred.
- `apps/platform-admin` handles organization creation and status, administrator appointment, aggregate counts, and entitlement grants. Operators are provisioned by trusted SQL in `platform_administrators`; tenant administrators cannot add themselves.
- Every new organization receives `organization_admin`. Other entitlement keys are absent or disabled until a platform operator grants them. Grants do not imply that deferred features have been built.
- Audit events are appended by database triggers in the mutation transaction. They contain actor ID, organization ID, action, target, time, and success, without student content or secrets. Rolled-back mutations do not produce success events.
- An active owner is required. Tenant admins cannot appoint or remove owners/admins; owners can manage roles but cannot remove the final active owner. Platform admin appointment does not change ownership.
- Suspending an organization stops organization role resolution for admin and teacher operations. Existing students retain their own class learning records under Phase 1 class membership policies.

To run the applications, build each workspace and start `node apps/org-admin/dist/cli.js` or `node apps/platform-admin/dist/cli.js`. Configure the same publishable Supabase environment variables as the teacher console, enable its Google provider, and add the corresponding `/auth/callback` URLs to Supabase Auth redirect settings. Both admin applications sign in with Google OAuth, without sending Supabase sign-in emails; access still requires the existing platform operator or active organization owner/admin record. To bootstrap a platform operator, insert an existing profile ID into `public.platform_administrators` through a trusted SQL administration session. Never expose service-role credentials to either app.

## Phase 3 governance status

The organization admin has Models, Sandbox, Usage, and Budgets sections. Models are versioned approved profiles with optional fallback links and versioned price records. Policies still resolve to one auditable `EffectivePolicy` before entering the learning runtime, though there is no Policies editor in the organization dashboard. Sandbox stores domains to block from Gondolin HTTP/HTTPS requests. The institution model gateway verifies each student request, reserves a bounded budget, and records provider-reported usage before returning a response. Usage is aggregated by day. The platform dashboard shows aggregate usage by organization.

Organization provider credentials remain server-side. Deployment requires `PI_STUDENT_MODEL_GATEWAY_URL` in the managed client and a gateway configured with Supabase service credentials and `PI_STUDENT_GATEWAY_PROVIDERS`. On 2026-09-17, the seven core migrations and live Supabase history were aligned, and all 108 assertions across the five pgTAP suites passed in rolled-back live transactions. On 2026-09-23, the institutional environment schema and PostgREST schema-cache refresh migrations were applied to the live project after the environment registry tables were found missing. The hosted gateway still needs deployment and an end-to-end model request before marking Organization V1 ready. Failed upstream calls leave reservations held for operator review.

## Deferred

The teacher console still creates and lists standalone classes by `teacher_id`. Class conversion, email invitations, billing, LMS integrations, managed sandbox image building and execution, private model endpoints, enterprise SSO, and support impersonation remain deferred. The organization admin supports the Sandbox domain block list and scoped Skills/MCP administration. Any future support access must be time-limited, explicit, and audited.
