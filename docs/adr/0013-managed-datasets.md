# 0013 — Managed dataset artifacts

Status: accepted for metadata; execution mounting requires a certified provider.

Datasets are immutable, versioned organization-owned artifact references with byte size, SHA-256, organization/class/project scope, guest mount path and access mode. They contain no host path or URL. Profile revisions refer to exact dataset revisions through composite foreign keys; the resolver rejects cross-scope assignments. The only permitted guest mount prefix is `/datasets/` with simple path components, so `..`, symlinks to arbitrary host data and arbitrary host mount requests are not representable in the registry. Read-only is the default.

The artifact service and sandbox provider must independently verify the hash, perform tenant-scoped artifact retrieval, mount read-only by default, and prevent guest symlink escapes or host traversal. Read-write datasets need isolated per-session copy-on-write state, never a shared source artifact. The current packaged Gondolin provider has no such artifact adapter and refuses profiles rather than mounting an unsafe host directory. Dataset registration does not upload or expose host files.
