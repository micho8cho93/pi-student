# 0011: Tenant usage ledger and daily aggregates

## Decision

Managed projects send institution model requests through `services/model-gateway`. The student sends a Supabase access token and a session ID. The gateway validates the token, then asks a service-role database RPC to verify the student, project, approved profile, thinking level, entitlement, and monthly budgets. The RPC serializes decisions per organization and reserves bounded tokens and estimated cost before the gateway contacts the provider. Only the gateway holds provider credentials. A request with no configured price is blocked when a cost budget applies.

The gateway caps output at 4,096 tokens, accepts text-only requests, and requires provider-reported usage. It settles each reservation with an idempotent ledger row before returning the model response. A trigger updates daily aggregates by organization, class, student, project, model, provider, and attributed teacher. Price versions produce estimated microdollar cost when known; cost remains `NULL` without a configured price. Organization admins can inspect daily slices; platform admins receive monthly tenant aggregates through a separate RPC.

Organization, class, user, and model monthly budgets have a warning fraction, cost and/or token cap, and a hard action. The client preflight gives early feedback, while the gateway reservation enforces the limit under concurrency. Management and price changes use entitlement-gated RPCs and append administrative audit events.

## Operational limits

The reservation uses the maximum allowed request size, so a small request may be rejected near a hard limit even if its actual cost would fit. A provider failure or response without verifiable usage leaves the reservation held. This fails closed for spending, but an operator must review and reconcile such reservations before reclaiming capacity. The implementation requires an OpenAI-compatible provider endpoint that returns usage for nonstreaming completions. It does not meter standalone personal credentials, sandbox compute, or storage.
