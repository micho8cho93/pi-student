# Pi Student sandbox architecture

Pi remains the model, session, and educational workflow engine. A
`SandboxRuntime` owns every project filesystem and process operation.

```text
Student -> terminal/GUI -> educational workflow -> Pi Agent
                                         |
                                 SandboxRuntime
                                         |
                                 GondolinRuntime
                                         |
                                 runtime resolver
                                    /          \
                            packaged krun   verified QEMU
                                    \          /
                               isolated /workspace
```

## Extension rule

Host-safe extensions may manipulate educational state, prompts, terminal UI,
and workflow state. Examples include `student_ask`, `student_plan`, the
question loop, and `WorkflowController`.

Sandbox-required extensions must use `SandboxRuntime` for filesystem access,
process execution, tests, git, and project operations. They must not call
Node `fs`, `child_process`, or equivalent host APIs for student project work.
The one narrow exception is the verified artifact export gateway: it reads a
single file through `SandboxRuntime` and, only after verification passes and the
student confirms the exact name, writes a non-overwriting copy to the host
Desktop. The agent never receives a general host filesystem tool.

| Host-safe | Sandbox-required |
| --- | --- |
| educational state | project filesystem |
| terminal UI | read/write/edit/list/search |
| prompts and question loops | shell commands and tests |
| workflow transitions | git and project processes |

Pi's built-in project tools are registered through a sandbox adapter. The
adapter uses `/workspace` as Pi's working directory, so the host project path
is not included in the model's working-directory context. Gondolin mounts the
student project at `/workspace`, so normal project edits already persist in the
student's chosen local project directory; only the Gondolin runtime imports
Gondolin APIs. Finished standalone artifacts can additionally be published via
`save_to_desktop` during REFLECT, after a passing verification result. Exports
are limited to workspace files, capped at 100 MiB, require interactive
confirmation, and refuse to overwrite an existing Desktop file.

Persisted interactive sessions use the real project directory only as their
host-side identity and storage key. Pi's agent session, resource loader,
extensions, and tool adapters still receive `/workspace`. This split lets Pi
validate and replace saved sessions on the host without exposing the host path
to the model or attempting to treat the guest-only mount as a host directory.

The resolver normalizes the host to `darwin-arm64`, `darwin-x64`, `linux-x64`,
or `linux-arm64`. It probes the packaged krun runner on Gondolin-supported
targets first, then requires both `qemu-img` and the matching
`qemu-system-aarch64` or `qemu-system-x86_64` executable. A backend is only
recorded in `~/.pi-student/config/runtime.json` after a guest command succeeds.
Startup probes the executable again rather than blindly trusting metadata.

The krun path uses an ephemeral raw root-disk reflink/copy because Gondolin's
default qcow2 overlay invokes `qemu-img` even when krun is selected. This keeps
krun independent of QEMU without making the guest root read-only. QEMU keeps
Gondolin's normal copy-on-write root disk.

If krun's real VM boot fails, the same runtime object attempts verified QEMU. If
QEMU also fails or is absent, startup stops. There is no host fallback.

`SANDBOX_MODE=gondolin` is the default. `--unsafe-no-sandbox` and the legacy
`SANDBOX_MODE=host` setting are available only for development and tests and are
explicitly unsafe: commands then run on the developer's host process.

Provider authentication stays on the host. Gondolin receives a small explicit
environment allowlist for project processes and never receives provider API
keys such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY`.

Installation owns the Node runtime, application, cache, image, launcher,
metadata, and logs under one `PI_STUDENT_HOME`. The curl installer performs
large downloads and OS package provisioning; normal application startup only
resolves and starts an existing runtime. Both terminal and GUI clients therefore
share one sandbox installation.
