# Pi Student SDK

`@pi-student/sdk` is the supported facade between applications and Pi Student's runtime and domain packages. It gives composition roots stable imports while the implementation remains in focused packages.

## What it is

- A curated public API for runtime composition, model providers, policies, classroom repositories, sandboxes, telemetry, and publishing.
- A set of TypeScript contracts suitable for application-owned or future remote adapters.
- The integration point for `createStudentRuntime({ modelProvider, sandboxProvider, policyProvider, telemetrySink, identityProvider, ... })`.

## What it is not

- It is not a second implementation of runtime, classroom, telemetry, or publishing behavior.
- It is not a service locator and does not create Supabase, Gondolin, GitHub, or Paseo automatically.
- It does not implement organization administration, billing collection, LMS integration, or cloud sandboxes. Institution governance enters through contracts and adapters; the gateway is a separate service.

## Public entry points

| Import | Supported surface |
| --- | --- |
| `@pi-student/sdk` | Runtime composition, direct model wrapper, stored/static policy providers, identity/model/policy/telemetry contracts |
| `@pi-student/sdk/runtime` | Student runtime and Pi agent session creation |
| `@pi-student/sdk/models` | `ModelProvider`, descriptors, resolution, and the current `DirectModelProvider` |
| `@pi-student/sdk/policy` | `PolicyProvider`, effective policy, parsing, and current providers |
| `@pi-student/sdk/classroom` | `ClassroomRepository`, classroom DTOs, and classroom runtime services |
| `@pi-student/sdk/sandbox` | `SandboxProvider`, `SandboxRuntime`, lifecycle manager, and profiles |
| `@pi-student/sdk/telemetry` | `TelemetrySink`, events, local record/context stores, and pending sync |
| `@pi-student/sdk/publishing` | `DeploymentProvider`, publishing service, and GitHub Pages provider |

`SkillProvider` and `McpProvider` are intentionally minimal discovery contracts. Runtime configuration accepts them as future extension points, but no registry or organization behavior is implemented.

## Composition example

```ts
const runtime = createStudentRuntime({
  projectPath,
  modelProvider,
  sandboxProvider,
  policyProvider,
  telemetrySink,
  identityProvider,
  classroom,
});

await runtime.start();
// Pass runtime.modelRuntime, runtime.sandbox, and runtime.services to the Pi session factory.
```

Concrete adapters remain explicit: `@pi-student/sandbox-gondolin`, `@pi-student/supabase-adapter`, `@pi-student/paseo-adapter`, and the GitHub classes in `@pi-student/publishing`.

## Organization control plane

The Supabase governance adapter authenticates the user, fetches institution policy layers and approved model profiles, and resolves one `EffectivePolicy` before entering the learning runtime. Institution models use the gateway through the `ModelProvider` boundary. Gateway-owned database RPCs reserve and settle usage. Organization IDs and admin rules stay outside the learning engine until translated into runtime-facing values.
