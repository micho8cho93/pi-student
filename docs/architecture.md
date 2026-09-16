# Pi Student architecture

Pi Student is an npm workspaces monorepo coordinated by Turborepo. Applications assemble capabilities; core packages contain domain behavior; adapters translate external systems into stable contracts.

## Repository shape

```text
apps/
  client/                 student CLI, terminal UI, installer lifecycle
  teacher-console/        teacher TUI and local web dashboard
packages/
  contracts/              stable provider and domain contracts
  sdk/                    supported internal facade
  runtime/                student runtime composition
  education/ policy/ classroom/ organization/ telemetry/ publishing/ sandbox/
  sandbox-gondolin/ supabase-adapter/ paseo-adapter/
infra/
  supabase/               migrations, config, and pgTAP tests
services/                 reserved workspace namespace; no services yet
tooling/                  architecture and release-boundary checks
docs/adr/                 architecture decision records
```

## Dependency direction

```text
Applications
     │
     ▼
@pi-student/sdk
     │
 ┌───┼──────────────┐
 ▼   ▼              ▼
Runtime   Classroom   Publishing
 │          │             │
 ├──> Education           │
 ├──> Policy <────────────┘
 ├──> Sandbox
 └──> Telemetry
             │
             ▼
     @pi-student/contracts

Adapters (outside the core):
Gondolin ──> SandboxProvider
Supabase ──> ClassroomRepository / IdentityProvider / TelemetrySink
Paseo ─────> SDK/runtime
GitHub ────> DeploymentProvider
```

Dependencies point downward. Adapters may depend on contracts and domain packages; domain packages do not depend on adapters. Applications are composition roots and may select concrete adapters. No package imports an application.

## Packages

- `contracts`: dependency-free identity, model, policy, runtime configuration, sandbox, telemetry, skill, and MCP contracts.
- `sdk`: the supported facade for embedding and application composition. It delegates to domain packages and contains no duplicated business logic.
- `runtime`: Pi session creation and the learning runtime. It consumes model, sandbox, identity, policy, classroom, and telemetry capabilities.
- `education`: learning workflow, intent routing, Learn Mode, question flow, planning, and project understanding.
- `policy`: capability parsing/enforcement and policy-provider implementations.
- `sandbox`: provider-neutral runtime lifecycle and Pi tool adapters.
- `classroom`: backend-neutral repository types, join-code rules, and project-building domain behavior.
- `organization`: provider-neutral tenant roles, capabilities, and control-plane authorization contracts; no classroom role overload or database dependency.
- `telemetry`: event recording, privacy, local persistence, and backend-neutral pending-record sync.
- `publishing`: publishing orchestration plus the `DeploymentProvider` contract and GitHub Pages implementation.
- `sandbox-gondolin`, `supabase-adapter`, and `paseo-adapter`: concrete integration packages.
- `shared`: small host utilities with no product-domain behavior.

## Composition roots

`apps/client` is the student composition root. It creates the direct Pi model provider, Gondolin sandbox provider, file-backed context store, policy provider, and—when configured—Supabase classroom, identity, and telemetry adapters. It passes those capabilities into `createStudentRuntime`.

`apps/teacher-console` is a presentation application. It uses the classroom domain and Supabase adapter for teacher administration while keeping terminal and dashboard UI out of the classroom package.

Organization control-plane capabilities are defined in `@pi-student/organization`, exposed through `@pi-student/sdk/organization`, and implemented for the current database by `SupabaseOrganizationAuthorization`. The Supabase governance adapter resolves an effective project policy before the learning runtime uses it. Neither the student client nor the learning runtime imports organization administration.

Paseo remains an adapter around the same shared runtime. GitHub Pages is selected by the publishing package through `DeploymentProvider`.

## Build and deployment units

The repository is one source-control unit, not one deployment unit.

| Unit | Build | Test | Package/deploy output |
| --- | --- | --- | --- |
| Student client | `npm run build:client` | `npm run test:client` | `npm run package:client`; platform archive consumed by `install.sh` |
| Teacher console | `npm run build:teacher` | `npm run test:teacher` | `npm run package:teacher`; standalone console archive |
| Organization administration | `npm run build:org-admin` | `npm run test:org-admin` | independent `apps/org-admin` HTTP application |
| Platform administration | `npm run build:platform-admin` | `npm run test:platform-admin` | independent `apps/platform-admin` HTTP application |
| Shared packages | `npm run build` or Turbo filters | `npm test` or Turbo filters | private workspaces; not published |
| Supabase infrastructure | n/a | `npm run infra:lint` and `npm run infra:test` | migrations applied by a separately authorized infrastructure workflow |

The teacher console has a **code boundary now** and can gain **deployment separation later**. The curl-installed client archive still carries its local command for compatibility, but `@pi-student/client` has no workspace dependency on `@pi-student/teacher-console`; loading is optional at runtime. A dashboard-only edit therefore does not make the client an affected Turbo package. Removing the bundled compatibility copy later is a packaging decision, not another source-tree restructure.

`scripts/package-release.sh` stages an allow-listed client closure and verifies it before producing an archive. It never copies `infra/`, database migrations, future services, GitHub workflows, source trees, or repository tooling. It preserves the `pi`, `pi-student`, and `pi-student-runtime` launchers and the current checksum-verified curl installer. `scripts/package-teacher-console.sh` creates the separate teacher artifact and excludes the client, Paseo, Gondolin, and database infrastructure.

## Infrastructure boundary

All Supabase assets live under `infra/supabase/`. The root commands start/reset the local stack, lint the schema, and run pgTAP tests. `CI Database` owns those checks. No workflow in this repository automatically pushes migrations to a linked or production project; adding such a workflow requires explicit environment protection and production credentials.

## CI affected strategy

`CI Core` runs Turbo's affected graph for pull requests and changes, with a full build/typecheck/test fallback on pushes to the default branch. Product workflows add explicit validation at deployment boundaries:

- `CI Client` reacts to client code and its dependency closure, builds/tests the filtered client graph, and inspects a Linux client archive.
- `CI Teacher Console` reacts to the teacher application and its dependency closure and validates its own archive.
- `CI Organization Admin` and `CI Platform Admin` react to their respective application paths and shared dependency closures; each builds and tests only its own workspace graph.
- `CI Sandbox` is the only ordinary workflow that boots the sandbox smoke test; teacher presentation changes do not trigger it.
- `CI Database` reacts to `infra/supabase/` and runs migrations, schema lint, and pgTAP tests locally.
- `Release Client` retains the `darwin-arm64`, `darwin-x64`, `linux-x64`, and `linux-arm64` matrix plus published SHA-256 checksums.

This gives the intended propagation: contracts/SDK changes fan out through Turbo; education, publishing, policy, runtime, and sandbox changes reach the client through declared dependencies; teacher-only presentation changes stay in the teacher unit; and migration-only changes stay in database CI.

## Enforced boundaries

`tooling/check-boundaries.mjs` fails CI for package-to-application imports, core-to-concrete-adapter imports, Supabase imports in classroom/organization/education/policy, runtime imports of Gondolin/Paseo/teacher UI/organization administration, client imports of organization administration, contracts imports of other Pi Student packages, and `src` deep imports across workspace packages. `npm run test:architecture` also verifies the public package roots.

Artifact allow lists are enforced independently by `tooling/verify-release-artifact.mjs`. Version rules are executable through `tooling/check-versions.mjs`.

## Versioning

- The repository/root version is the Pi Student client release version. `apps/client/package.json` must match it, and client tags use `v<version>`.
- `@pi-student/sdk` and all other workspace packages are private. Their versions describe the in-repository compatibility set; they are not independent npm releases.
- SDK compatibility is validated with the monorepo build and affected dependents. A breaking facade change requires a client version change and an ADR or migration note, but no public SDK publication.
- The teacher console may receive an independent deployment version later. Until that release process exists, its workspace version tracks the repository compatibility set while its artifact remains independently buildable.

## Administration boundaries

`apps/org-admin` and `apps/platform-admin` are separate workspace packages and processes. They run on ports 4174 and 4175 by default, accept only a Supabase URL and publishable key, and rely on database RLS and restricted RPCs. The former requires an active organization owner/admin plus the `organization_admin` entitlement. The latter requires a row in `platform_administrators`, provisioned by trusted SQL. A platform operator can see aggregate class, member, student, and session counts, but platform role alone does not grant class or student content access. Both applications can be built and validated independently in Turbo and CI. The student client and teacher console have no dependency on either app.

`services/control-plane-api` remains absent. Database RPCs provide the transactional boundary for membership, entitlement, platform configuration, and audit events. A trusted model gateway remains necessary for hard budgets and institution-held provider credentials. See [ADRs 0006–0011](adr/README.md).

## Reserved future boundaries

The following names are reserved but intentionally do not exist as empty workspace packages:

```text
services/control-plane-api/
services/usage-worker/
services/integration-worker/
```

When real implementations are approved, apps depend on the SDK/control-plane API, services depend on contracts and adapter interfaces, and none may be imported by the client runtime. Avoiding empty workspaces keeps CI and dependency maintenance quiet today.

## Organization integration point

Organizations are tenants above classes. `organization_memberships` is separate from `class_members`; managed classes have `classes.organization_id`, and existing standalone classes keep `NULL`. Database RLS combines active tenant membership with class membership for teacher operations, while students continue to use class membership. The governance adapter translates platform → organization → class → project → session policy layers into one `EffectivePolicy`; the learning engine does not understand tenancy, billing, or the hierarchy.

See [the Organization status record](organization-readiness.md) and [ADR 0005](adr/0005-organization-tenancy-foundation.md) for transitional ownership and authorization decisions.
