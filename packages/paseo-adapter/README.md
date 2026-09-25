# Paseo integration

Paseo is a frontend for the same runtime used by Pi Student's terminal mode.
The installed configuration derives a provider from Paseo's native `pi`
adapter and replaces its command with `pi-student-runtime`. Paseo appends
`--mode rpc`; the wrapper starts Pi Student's ordinary session factory,
educational extensions, tool policy, and sandbox.

`config.json` is the source template. Installation replaces
`__PI_STUDENT_RUNTIME__` with the absolute path to the application-owned
launcher and writes the result under `~/.pi-student/paseo/config.json` (or the
selected `PI_STUDENT_HOME`). That isolated Paseo home hides unrelated agent
providers, disables Paseo MCP/tool injection and relay access, and enables the
bundled local web UI.

Paseo's Pi adapter translates Pi RPC extension dialogs (`select`, `input`,
`editor`, and `confirm`) into graphical question/permission controls. This is
why the existing `student_ask` extension requires no GUI-specific version.

Paseo itself includes general workspace, terminal, and Git UI features. For
the student build, the terminal profile list is explicitly empty and the
launcher applies a small web UI shell override that removes host management,
session import, schedules, browser launch, and profile-management controls.
The student launch choices are Chat, Terminal, and Flowchart in both existing
workspaces and the new-workspace screen. Flowchart opens a read-only, zoomable
diagram generated from the selected project's current source files. Refresh
scans the source again and regenerates the diagram.

The file editor offers local keyword and in-file word completions while typing,
or on Ctrl/Command-Space. Its **Complete · AI off** button opens the completion
settings. AI suggestions are opt-in, have a visible model selector and a choice
of 2, 5, or 10 requests per minute, and appear after a short pause at the end
of a code line. Tab accepts a suggestion and Escape dismisses it. The bridge
also caps AI requests at 10 per minute and 100 per rolling 24 hours per
workspace. It sends
only a bounded excerpt of the open buffer to the chosen model. Nearby files
are never included automatically. Managed projects resolve current
model policy and provider approvals before showing or calling models; the
institution gateway handles institution-model usage and budget settlement.
The editor hook is checked against the supported Paseo bundle at launch so an
upstream editor change fails visibly instead of silently disabling completion.
This is an app-shell restriction; it does not change Paseo's underlying generic
workspace capabilities.

Chat, the editor, and Flowchart share a local workspace event stream
(`@pi-student/runtime/workspace-events`). The editor reports only metadata —
which file was opened, edited, or selected, and when an AI suggestion was
accepted — to the bridge's `/workspace-events` endpoint; it never sends file
contents. The chat runtime records its own file edits, commands, and test
results. Both processes share a bounded, per-workspace journal under the Pi
Student config directory, keyed by project path and class project, so events
never cross workspaces. Chat receives a short summary at each prompt (files
the student changed vs. files the assistant changed, the latest test result
with a few redacted failing lines, and whether the flowchart is out of date).
Credential-like paths are excluded from that summary. The Flowchart tab shows
when source files have changed since it was generated.
