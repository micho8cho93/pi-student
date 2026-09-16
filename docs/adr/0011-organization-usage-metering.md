# 0011: Tenant usage ledger and daily aggregates

## Decision

Each model response creates an idempotent usage event with a client event UUID, session and project IDs, model identity, input and output tokens, and cache tokens. A local outbox retries failed uploads. The database derives organization, class, student, and approved model from the authenticated subject and project; it ignores client-supplied tenant attribution. The ledger records `client_reported` as its source. Immutable price versions produce estimated microdollar cost when known; cost remains `NULL` when no price is configured. A trigger updates daily dimensional aggregates used by the organization dashboard. The platform dashboard reads a separate aggregate RPC and has no ledger or student record access.

Organization, class, user, and model monthly budgets have a warning fraction, cost and/or token cap, and a hard action. A server-side preflight checks current aggregates. Cost budgets fail closed when a price is missing or existing usage is unpriced. Management and price changes use entitlement-gated RPCs and append audit events.

## Security and remaining enforcement gap

The present Pi provider still calls upstream models directly from the student host using its existing personal credential store. A client can omit or falsify a usage event, and a preflight based on completed usage cannot reserve concurrent or in-flight spend. Therefore this ledger is useful for reported institutional visibility but **does not certify provider billing**, and the preflight **does not guarantee a hard monetary ceiling**. The current model profiles are an approved allowlist for the honest client; they are not centrally funded model access.

Before enabling centrally paid organizational AI, introduce a narrowly scoped model gateway under `services/` that owns provider credentials, authenticates each request, resolves the approved profile, atomically reserves bounded usage, enforces output limits, and commits provider-reported usage. The gateway must reject requests when a hard limit cannot be guaranteed and reconcile unused reservations. Only gateway-sourced ledger entries may be used for financial enforcement. This is a prerequisite for claiming Organization V1 complete.
