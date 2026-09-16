# 0001: Monorepo and deployment units

## Context

Pi Student needs shared types and behavior without coupling client, teacher UI, database changes, and future services into one release.

## Decision

Use npm workspaces and Turborepo. Keep deployable applications in `apps/`, future backends in `services/`, shared private code in `packages/`, and Supabase assets in `infra/`. Client and teacher console have separate filtered build/test/package commands and verified allow-listed artifacts.

## Alternatives considered

Separate repositories would increase coordination and version skew. One root application/tarball would keep releases coupled. Publishing every internal package would create unnecessary release overhead.

## Consequences

One change can be tested through the dependency graph while products remain independently packageable. Workspace manifests and boundary tests must accurately describe dependencies.
