# 0004: Multi-tenant direction

## Context

The current Supabase model is class-centric, uses teacher/student roles, and treats teacher membership as its administrative boundary. Future organizations need tenant isolation and additional administration roles.

## Decision

Do not implement organizations in the client or overload classroom roles. A future control-plane model will place organization membership above classes, resolve configuration/policy before execution, and pass optional organization correlation through existing contracts. Cross-tenant RLS tests are a prerequisite for admin UI.

## Alternatives considered

Adding nullable organization columns immediately would create an incomplete security model. Reusing teacher roles for organization administration would conflate classroom participation with tenant authorization.

## Consequences

Today's behavior remains stable. Organization delivery begins with contracts, authorization semantics, and migrations, followed by control-plane APIs and only then admin applications.
