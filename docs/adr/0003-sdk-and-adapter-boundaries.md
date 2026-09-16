# 0003: SDK and adapter boundaries

## Context

Core learning behavior previously risked binding directly to Supabase, Gondolin, Paseo, and Pi provider configuration.

## Decision

Expose stable contracts and an internal `@pi-student/sdk` facade. Put concrete infrastructure in adapter packages. Applications are composition roots and may select adapters; runtime/domain packages may not import them. Enforce the direction with executable import checks.

## Alternatives considered

Direct vendor imports are initially simpler but make replacement and hosted deployment difficult. A large universal abstraction layer would obscure domain-specific contracts.

## Consequences

Infrastructure can change independently and future apps have a supported entry point. Contract changes require deliberate compatibility review and affected-dependent validation.
