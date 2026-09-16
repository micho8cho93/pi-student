# Organization-readiness audit

This audit records seams and assumptions only. It does not implement organizations, organization roles, tables, billing, quotas, hosted sandboxes, or a model gateway.

## Summary

The runtime/domain direction is ready for a future control plane: core packages consume interfaces, concrete Supabase/Gondolin/Paseo code is outside the core, and application composition roots select adapters. The current classroom schema remains intentionally class-centric and teacher/student-specific. That persistence model is the main area to evolve when Organization work begins.

## Role assumptions

- `packages/contracts/src/identity.ts` defines `ClassRole` as `teacher | student` and `IdentityKind` as `anonymous | personal | student | teacher`. These describe current classroom/runtime behavior, not a platform-wide authorization enum. Do not add `organization_admin` or `platform_admin` to them; future control-plane roles should use a separate tenant authorization contract.
- `infra/supabase/migrations/20260913083923_teacher_integration_mvp.sql` constrains `class_members.role` to teacher/student and its RLS helpers authorize teachers. The migration is a snapshot of current product semantics.
- Teacher commands and dashboard views assume a teacher operating directly on classes. They belong to `apps/teacher-console`, so future admin applications can use different roles without leaking them into the student runtime.

Recommended evolution: introduce control-plane `OrganizationMembership`/`PlatformRole` contracts, then map classroom permissions to effective capabilities. Preserve `ClassRole` for within-class behavior until the database migration is designed.

## Class ownership assumptions

- The initial migration stores `classes.teacher_id`, inserts a teacher membership for that user, and uses `private.is_class_teacher(class_id)` as the write-authorization boundary.
- Projects, standards, memberships, sessions, and teacher read access flow from `class_id`. `ClassroomRepository` likewise scopes project listing and creation by class.
- There is no organization parent or organization membership. A class can have teacher memberships, but the creator/teacher boundary is effectively the administrative owner.

Future shape: `organization -> class -> class_membership`, with organization membership authorizing class administration and class membership continuing to describe classroom participation. Migrate RLS helpers from “is class teacher” to capability checks derived from both membership layers. Do not simply add `organization_id` and continue trusting `teacher_id` as the tenant boundary.

## Infrastructure dependencies

| Concern | Current dependency | Result |
| --- | --- | --- |
| Supabase | Only `packages/supabase-adapter` and the teacher/client composition roots use Supabase. Classroom, policy, education, telemetry, and runtime use contracts. | Ready; direct app use is allowed at a composition root. |
| Gondolin | `packages/sandbox-gondolin` implements `SandboxProvider`; runtime depends on `packages/sandbox`. | Ready. The legacy mode string `gondolin` is public configuration debt, not a direct dependency. |
| Paseo | `packages/paseo-adapter` owns GUI integration; the client invokes it. Runtime has no Paseo import, enforced by the boundary check. | Ready. A few cross-package tests exercise adapters intentionally. |

## Policy assumptions

Current effective policies are stored per project in Supabase or read from local selected context. `EffectivePolicy.projectId` is required, and `StoredPolicyProvider` returns one already-effective policy. There is no inheritance or merge algorithm.

The future control plane should resolve, in order, platform default → organization → class → project → session and pass one immutable `EffectivePolicy` through `PolicyProvider`. Precedence, null/deny semantics, version stamps, and audit provenance must be designed before schema work. The runtime should never query each layer itself.

## Telemetry assumptions

Stable records already carry session, class, user/student, and project correlation. Contracts now reserve optional `organizationId` on identity, teacher context, learning-record sessions, and usage events; existing callers are unchanged and organization is never required. `UsageEvent` can also carry optional class/user/project correlation.

Remaining debt: `LearningRecord.session.studentId` is student-specific. A later schema version may introduce neutral `userId` while retaining backward-compatible reads. Remote sinks must derive tenant scope from authenticated server-side context and must not trust a client-supplied organization identifier for authorization.

## Model configuration assumptions

Today `DirectModelProvider` wraps Pi's user-configured providers and model catalog. Runtime consumes `StudentModelProvider`/`ModelProvider`; setup UI and credentials remain client concerns. A future `OrganizationModelProvider` or `ModelGateway` implements the same resolution boundary and is selected by the application/control plane. Gateway policy, credentials, billing, and token enforcement do not belong in the learning runtime.

## Sandbox assumptions

Today the client selects the local Gondolin provider, with host mode as an explicit unsafe developer escape hatch. The future control plane can resolve a `SandboxProfile` before runtime creation. That profile should describe language/runtime, pre-installed libraries, read-only dataset mounts, network policy, and resource limits, while `SandboxProvider` remains responsible for translating it to local or cloud infrastructure. Profile storage, cloud execution, and organization selection are intentionally not implemented.

## Safe first Organization slice

Start with control-plane contracts and a persistence/RLS design, not UI. Define organization identity/membership and effective-policy resolution DTOs in a service boundary, write an ADR for tenant authorization, and design a migration that attaches classes to organizations without changing student runtime behavior. Only after RLS tests cover cross-tenant denial should an `org-admin` application be created.
