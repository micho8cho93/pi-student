# 0005: Organization tenancy foundation

## Context

The existing classroom schema treats `classes.teacher_id` as the write boundary. It also has live standalone classes and a student runtime that consumes resolved identity and classroom capabilities. Organization administration needs a separate authorization scope without migrating every existing class or changing `ClassRole`.

## Decision

An organization is a tenant. `organization_memberships` holds active or suspended roles (`owner`, `admin`, `teacher`, `member`) separately from `class_members` (`teacher`, `student`). The provider-neutral `@pi-student/organization` package defines these roles and a small authorization/administration API. A `PlatformRole` exists as a distinct control-plane concept; no client can assign it in this phase. Platform operations use trusted server credentials and are outside classroom RLS.

`classes.organization_id` is nullable. Existing rows stay `NULL` and remain standalone; new organization-managed classes specify an organization. A class cannot be reassigned between organizations by an authenticated client. `teacher_id` remains for legacy creator attribution and existing teacher console queries. Its value alone never grants access to an organization-managed class.

For managed classes, an active organization owner/admin can manage classes and their resources. An organization teacher needs both active organization membership and active teacher membership in the specific class. An organization member gets no class access. A student needs an active class membership and does not need organization administration membership. Join codes continue to create pending class memberships. For standalone classes, the creator's active teacher class membership retains existing management rights. A class's projects, standards, requirements, and learning records inherit access through class-scoped policies; a teacher or admin reads a student's records only when the student has an active class membership.

RLS evaluates the authenticated database user, not a client-supplied organization ID. Small security-definer helpers in the unexposed `private` schema resolve active membership and class capabilities. Public RPCs create an organization and maintain memberships with role escalation and final-owner checks. Public tables grant only the necessary operations. Removing or suspending organization membership immediately revokes managed teacher/admin access. The database does not copy organization roles into JWT metadata.

The student runtime continues to receive already-resolved identity, configuration, classroom repository, and telemetry capabilities. It does not query organization membership tables or administer organizations. Optional organization correlation remains optional in runtime and telemetry DTOs.

## Transitional behavior

| User | Behavior |
| --- | --- |
| Personal Pi Student | No organization or class is required. |
| Teacher with an existing standalone class | Existing `organization_id = NULL` class and its projects remain accessible. New teacher console classes remain standalone until a managed creation flow is added. |
| Student in an existing standalone class | Existing class membership and learning-record flow continue. |
| Organization teacher | May create a class in an active organization; manages only classes where they are an active teacher member. |
| Organization student | May join by code and, once approved, access their class resources and sessions without organization membership. |

No existing class is silently assigned to a tenant. A later conversion requires a dedicated audited server operation that checks all related data and membership implications. This phase does not add a conversion API.

## Consequences

Organizations can have multiple owners/admins and users can join multiple organizations. RLS prevents cross-tenant reads and writes, while class participation remains narrower than tenant membership. The teacher UI still lists classes by `teacher_id`, so it does not yet expose organization admin views; those belong to a later control-plane application. Organization-managed class creation can be made by a future service or client using the stable contract and database policy. Billing, dashboards, model governance, LMS integration, sandbox profiles, and Skills/MCP administration are deferred.
