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
The remaining launch choices are the student agent and the terminal. This is
an app-shell restriction; it does not change Paseo's underlying generic
workspace capabilities.
