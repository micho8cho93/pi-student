# 0006: Administration applications

## Decision

`apps/org-admin` and `apps/platform-admin` are independent npm workspaces and HTTP processes. The student client and teacher console remain separate build and deployment units. Administration apps use the publishable Supabase client, RLS, and restricted RPC contracts. Turbo filters and separate CI workflows validate each app independently.

No `services/control-plane-api` is created in Phase 2. The database already supplies the required hosted transactional boundary. Adding a service now would duplicate authentication and authorization without deployable behavior that needs it. A future service must expose stable contracts and stay outside student runtime dependencies.

## Consequences

Each app can be built and deployed independently. A change limited to the organization admin UI does not enter the client or teacher dependency graph. Changes to shared packages still fan out through Turbo. The current local HTTP serving pattern matches the teacher console; production hosting may replace it without merging application code.
