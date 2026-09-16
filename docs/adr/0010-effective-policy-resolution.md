# 0010: Resolve organization policy before entering the learning runtime

## Decision

The control-plane adapter obtains the current managed project, its class and organization, the versioned governance layers, and the approved model catalog through tenant-authorized database reads. `resolveEffectivePolicy` merges platform default → organization → class → project → optional session override into one `EffectivePolicy`. The runtime receives only that object and its ordinary capability settings. Standalone projects continue to use their stored project policy.

An absent field inherits. Boolean `false` is sticky, so a lower layer cannot re-enable a higher-level denial. Numeric limits are minima; `null` means no new cap. Nonempty model and thinking-level arrays intersect; an empty intersection fails closed. Class, project, and session patches may mention only paths delegated by the organization policy. The database checks teacher scope and delegated paths when a layer is saved; the resolver checks again when it is read. Platform restrictions passed to the resolver are immutable to lower layers. The current platform layer is the code-owned default; there is no platform editing UI.

`EffectivePolicy.provenance` records the source scope, version, and reason for each applied path. The effective policy is copied into the immutable session policy snapshot. A managed project cannot fall back to a stale local policy if control-plane resolution fails.

## Consequences

The learning engine stays unaware of tenancy and hierarchy. Administrators can inspect layers, versions, and session policy provenance. The existing project capability column remains a compatibility input; only differences from its default are applied at project scope. Unauthorized or invalid lower-level settings fail closed. A policy editor that saves JSON is an interim administrator interface and should gain field-specific controls before broad rollout.
