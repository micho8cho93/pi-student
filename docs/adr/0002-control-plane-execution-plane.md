# 0002: Control plane and execution plane

## Context

Organizations will eventually manage identity, policy, models, integrations, and usage, while student code executes locally or in a sandbox.

## Decision

Keep organization administration and effective-configuration resolution in a future control plane. The student execution plane accepts resolved identity, policy, model, sandbox, telemetry, skill, and MCP providers through contracts; it does not own tenancy or billing.

## Alternatives considered

Embedding organization logic in the CLI would expose administrative concerns and credentials. Premature microservices would add operational cost before the boundaries have real workloads.

## Consequences

Local/personal use remains possible, and a hosted control plane can be introduced without replacing learning behavior. Connectivity, caching, and configuration-signing rules will need a later ADR.
