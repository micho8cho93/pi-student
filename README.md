# Pi Student

Pi Student is an educational coding agent built on Pi with terminal and Paseo
GUI interfaces. Project files and commands run inside a secure local sandbox;
provider credentials and the teaching workflow remain on the host.

Pi Student has one shared agent runtime. Terminal and GUI modes are simply two
ways of interacting with the same agent. They use the same prompts, learning
workflow,
extensions, session files, tool policy, and sandbox, so students can switch
interfaces without reinstalling or duplicating a project.

Edits made in `/workspace` persist in the local project directory selected when
Pi Student starts. After review and successful verification, the agent can also
offer to save a finished file directly to the user's Desktop. This export
requires confirmation, accepts only sandbox workspace files up to 100 MiB, and
never overwrites an existing Desktop file.

## Learn Mode

Use **Learn ○ / Learn ●** beside the chat's thinking controls to explore the
current codebase without leaving your workspace. Ask for an overview, an
architecture diagram, a feature trace or an explanation of a particular file.
Learn is read-oriented and does not quiz. Switching it off resumes the existing
implementation workflow with the same conversation, model and thinking level.

Terminal parity: `/learn [on|off]`. For separate active recall, use
`/question [easy|medium|hard] [topic]`; `/question off` exits practice.

See [Learn Mode implementation and validation](docs/learn-mode.md) for the shared
repository model, persistence, GUI integration, supported analysis and limitations.

## Install

Once this repository's GitHub release location is configured, installation is
one command:

```bash
curl -fsSL https://github.com/OWNER/REPOSITORY/releases/latest/download/install.sh | sh
```

The release workflow replaces the installer's release URL automatically. Replace
`OWNER/REPOSITORY` above with this repository's GitHub slug when publishing; no
remote is recorded in this source snapshot, so it cannot be filled in safely here.

The default installer detects macOS/Linux and arm64/x64, downloads a
checksum-verified Pi Student archive and a pinned application-owned Node
runtime, installs Paseo 0.8, prepares the sandbox image, boots a real VM, and
installs the `pi`, `pi-student`, and `pi-student-runtime` launchers. It is safe to
rerun: project files, configuration, sessions, and caches are preserved, PATH
entries are not duplicated, and an older working app/runtime is restored if
verification of an update fails.

Open a new terminal, then choose an interface or launch one directly:

```bash
# Choose interactively
pi-student

# Existing terminal experience
pi-student terminal

# Paseo local/web GUI
pi-student gui

# Diagnose problems
pi-student doctor
```

`tui` and `web` are aliases for `terminal` and `gui`. On first use, either
interface may guide the student through model-provider setup. GUI mode starts
the application-owned Paseo daemon only when needed and opens
`http://127.0.0.1:6767` in the default browser.

The default is Terminal + GUI. A terminal-only installation is also available:

```bash
curl -fsSL https://github.com/OWNER/REPOSITORY/releases/latest/download/install.sh | sh -s -- --terminal-only
```

`--with-gui` is an explicit alias for the default install behavior.

For local development, install dependencies and run the checked-out app
directly:

```bash
npm install
npm start
```

The development start command builds the app, uses the repository's Paseo
dependency, and creates a development shared-runtime launcher when needed. The
release installer continues to use its application-owned Paseo runtime.
See [the monorepo architecture](docs/architecture.md) for application, package,
dependency, and deployment boundaries. Embedders and new applications should
use the supported [`@pi-student/sdk` facade](docs/sdk.md) instead of reaching
into package implementation files.

## Publish student websites

In the GUI, click **Connect** in the GitHub sidebar. Pi opens GitHub in your
browser and shows a one-time code to copy. Approve access on GitHub and Pi
updates the connection automatically. No terminal commands or separate GitHub
CLI installation are needed.

From the terminal, you can also connect and publish:

```bash
pi github connect
pi publish
```

`pi-student github connect` and `pi-student publish` are equivalent when the
short command is not installed. The first publish explains that the repository
and source will be public and asks for confirmation. Pi then shows the major
steps—Git repository, commit, push, and GitHub Pages deployment—and returns both
the live site and repository URLs. Later publishes reuse the same repository.

The GUI adds concise GitHub and Deployments sections to the left sidebar, plus
repository and deployment detail panels. Both interfaces use the same host-side
publishing service and metadata. See
[GitHub publishing architecture](docs/github-publishing.md) for permissions,
security boundaries, deployment behavior, and provider extension points.

## Shared runtime and Paseo

```text
                 Pi Student Core
        prompts / learning workflow / extensions / rules
                        |
              ---------------------
              |                   |
         Terminal UI          Paseo GUI
                                    |
                           Pi RPC over stdio
```

Paseo runs the custom `Pi Student` provider, whose command is the installed
`pi-student-runtime` launcher. Paseo adds `--mode rpc`; the launcher then enters
the same Pi Student runtime factory used by terminal mode. Structured extension
dialogs such as student questions, choices, text input, and confirmations are
carried over Pi's RPC extension-UI protocol and rendered by Paseo.

Pi Student uses an isolated Paseo configuration under
`~/.pi-student/paseo/`. Unrelated providers are hidden, relay and Paseo MCP tool
injection are disabled, and only the local web UI is enabled. See
[`packages/paseo-adapter/README.md`](packages/paseo-adapter/README.md) for the integration
contract.

Paseo 0.8 still includes general-purpose workspace, terminal, and Git screens
that cannot all be hidden through configuration. Those screens act directly on
the host and are not part of the Pi Student agent sandbox. Work initiated in a
Pi Student conversation remains governed by Pi Student's educational policy;
students should use the agent conversation rather than Paseo's generic terminal
or Git controls. Removing or policy-routing those generic screens is necessary
before treating the GUI as a locked-down kiosk environment.

## Appearance and themes

The interactive UI groups the workspace summary, prompts, shell activity, file
changes, and tool results into clearly separated panels. Color is semantic:
active shell work uses the current accent, warnings use amber/yellow, successful
work uses a quiet positive tint, and red is reserved for actual failures and
removed diff lines.

Use `/theme` to open the theme picker, or switch directly by name:

```text
/theme tokyo-night
/theme catppuccin-mocha
/theme paper-light
```

Pi Student includes `pi-student`, `tokyo-night`, `catppuccin-mocha`, `nord`,
`gruvbox-dark`, `cyber-neon`, `mono-dark`, `paper-light`, and
`catppuccin-latte`. The selection is saved for later sessions. Short aliases
such as `/theme catppuccin`, `/theme tokyo`, and `/theme mono` also work.

While the workspace and model are loading, Pi Student shows a small animated
loader with rotating programming-history facts. During a response, the
working indicator changes to student-facing milestones such as “Inspecting the
relevant files” and “Running a check,” and the footer explains that `Esc` can
stop the run. The assistant also writes concise public work notes before and
after meaningful actions. Those notes, tool calls, edits, and verification
results remain in chronological order after the response finishes; the closing
summary is an addition, not a replacement. Provider-supplied reasoning remains
available in a disclosure that is collapsed by default. Private model
chain-of-thought and secrets are never requested.

The installation is contained under `~/.pi-student/` by default:

```text
~/.pi-student/
├── app/
├── bin/pi-student
├── bin/pi-student-runtime
├── runtime/node/
├── runtime/paseo/
├── paseo/config.json
├── images/
├── cache/
├── logs/
└── config/runtime.json
```

Set `PI_STUDENT_HOME` before installation to choose a different application
directory.

## Diagnose and repair

```bash
pi-student doctor
pi-student doctor --verbose
pi-student repair
pi-student repair --verbose
```

`doctor` validates the launcher, application, runtime, cached image,
configuration, workspace access, and a real sandbox boot. Normal output uses
student-friendly terms; `--verbose` includes backend paths and fallback details.

`repair` recreates installation-owned directories and the launcher, downloads a
missing image, reruns the sandbox smoke test, and refreshes runtime metadata. If
application or native runtime files are missing, rerun the curl installer; it
uses the same repair/smoke-test path before reporting success.

Troubleshooting logs are in `~/.pi-student/logs/`. They never intentionally
include provider credentials.

## Supported systems

| Platform | Preferred backend | Automatic fallback |
| --- | --- | --- |
| macOS arm64 | packaged krun | QEMU through an existing Homebrew installation |
| macOS x64 | QEMU | QEMU through an existing Homebrew installation |
| Linux x64 | packaged krun | QEMU packages on Debian/Ubuntu |
| Linux arm64 | QEMU | QEMU packages on Debian/Ubuntu |

Windows and CPU architectures other than arm64/x64 are rejected with a concise
message. Automatic QEMU provisioning on Linux currently supports apt-based
Debian/Ubuntu systems. The installer does not install an entire package manager
on macOS.

## How sandbox selection works

Both interface entry points share the same `SandboxRuntime` layer:

```text
pi-student core ──┬── terminal
                  └── GUI
                       │
                SandboxRuntime
                       │
                    Gondolin
                       │
                  krun → QEMU → fail closed
```

The application explicitly selects Gondolin's backend. A packaged, executable
krun runner is preferred only on targets Gondolin publishes (`darwin-arm64` and
`linux-x64`). If krun cannot boot, Pi Student verifies both `qemu-img` and the
architecture-specific `qemu-system-*` before falling back. It never runs project
commands on the host because sandbox startup failed.

The krun adapter creates an ephemeral reflink/copy of the raw guest disk. This
keeps the guest root writable without pulling in Gondolin's QEMU-based qcow2
tooling. The mounted student project remains writable at `/workspace`.

An unsafe host backend exists only for explicit local development:

```bash
npm run build
node apps/client/dist/cli.js --unsafe-no-sandbox
```

The legacy `SANDBOX_MODE=host` environment setting is retained for automated
tests. Neither unsafe mode is enabled by the installer.

## Development

Development requires Node.js 23.6 or newer:

```bash
npm install
npm test
npm run build
```

The deployment units can also be validated independently:

```bash
npm run build:client
npm run test:client
npm run package:client

npm run build:teacher
npm run test:teacher
npm run package:teacher
```

The client package is the curl-installable platform artifact. The teacher
console also has its own artifact; its local command remains in the client
archive temporarily for compatibility, without being a client workspace
dependency. Supabase is an infrastructure boundary and is validated separately:

```bash
npm run infra:start
npm run infra:reset
npm run infra:lint
npm run infra:test
```

These commands use only a local Supabase stack. They do not deploy migrations
to a linked or production project.

Run the real virtualization smoke test separately:

```bash
npm run test:sandbox
```

Build the current host's platform release archive with `npm run package:client`,
or select and validate a platform label explicitly with:

```bash
./scripts/package-release.sh darwin-arm64
```

Tagging `v*` runs [.github/workflows/release.yml](.github/workflows/release.yml),
which builds all four platform archives, publishes `SHA256SUMS`, renders the
installer with the repository's release URL, and attaches everything to the
GitHub release.

See [docs/sandbox-architecture.md](docs/sandbox-architecture.md) for the security
boundary and runtime lifecycle. See
[packages/education/src/intent.ts](packages/education/src/intent.ts) for intent routing and
student questions, project context, and the Learning Boundary.

## Optional teacher integration

Teacher integration adds structured learning records and a small dashboard while
keeping standalone Pi Student fully functional. It never syncs API keys, source
files, raw prompts, complete responses, or transcripts.

Configure a Supabase project with the migrations under `infra/supabase/migrations/`,
then set its public client values (never a service-role or secret key):

```bash
export PI_STUDENT_SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export PI_STUDENT_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."
```

When running from this repository, you can put the same values in the
gitignored `.env.local`; Pi Student loads it automatically and remembers the public
classroom connection settings for launches from other directories.

Teachers sign in, create classes, approve join requests, and review activity in
the terminal dashboard at:

```bash
pi-student teacher
```

The independently packaged entrypoint is `pi-student-teacher`; it is prepared
for later hosted deployment while the compatibility command above remains.

The explicit `tui` alias is also available:

```bash
pi-student teacher tui
```

The interactive teacher dashboard mirrors the browser dashboard with boxed class,
activity, student, project, and session cards. Type a displayed number to open a
card or switch sections, or use short commands such as `today`, `students`,
`projects`, `approve 2`, `requirement 1`, `back`, and `quit`. In the Projects
section, `new` opens a conversational project builder: describe the idea, answer
Pi's clarifying questions, review the student-facing brief, and confirm before
saving. Use `edit <number>` later to manually revise the brief. Its browser dashboard
runs alongside it, and the localhost URL stays visible in every terminal view;
type `web` to open it. The browser-only dashboard remains available with
`pi-student teacher web`.

```bash
pi-student teacher auth login google
pi-student teacher class create "AP CSP — Period 2"
pi-student teacher project create <class-id> "Weather app"
pi-student teacher project requirement <project-id> "Use at least one data source"
pi-student teacher project list <class-id>
```

Students can open Pi Student and code independently before joining a class.
Inside the interactive terminal:

- `/join-class` asks for the teacher's code and uses Google sign-in if needed. Active memberships open the project picker; pending requests explain that teacher approval is required.
- `/projects` lists the student's approved classes and their projects, newest first. It works before the first prompt or between responses. The selected assignment and requirements become available to the agent in the current workspace.
- `/sync` saves the current record and retries uploads. The terminal shows whether classroom sync succeeded or is pending.

## Dictation

Student prompts support speech-to-text dictation. Press `Ctrl+Shift+D` to start
or stop it; the transcript is inserted into the editor for review before you
submit it. The shortcut opens guided setup if dictation is not configured.

Dictation uses a temporary WAV recording and deletes it after transcription. By
default it uses the bundled Desert Ant Voz on-device recognizer through `da voz`
on Apple silicon. The Pi Student installer owns the Voz runtime and its model
cache; users do not need to install a separate CLI. The guided flow can switch to OpenAI, Groq, or automatic local
Whisper. Voz and local Whisper keep recordings on the device; remote use asks
for consent before recording. The environment variable
`PI_STUDENT_DICTATION_COMMAND` remains available as an advanced override for a
custom local transcriber. `ffmpeg`, a working microphone, and the Desert Ant
CLI are required for Voz capture.

The Paseo GUI exposes the same on-device dictation through its `Ctrl+Shift+D`
shortcut and the microphone button in the chat input.

Switching projects saves earlier activity under the original project and starts a
new record for subsequent work. It keeps the current files and conversation open.
Project completion status is not yet stored in the classroom schema, so the picker
shows all projects without inventing completed/upcoming labels.

The existing shell commands also remain available:

```bash
pi-student auth login google
pi-student class join ABC-234
pi-student project list
pi-student project select <project-id> --requirements <id,id>
```

Class-linked records sync at startup, after responses, on project changes, and
on exit, including sessions with no successful model response. Records are saved
locally before upload and updated checkpoints are retried automatically.

At the end of a session with agent activity, the student can enter, review, edit, and
confirm a four-question reflection. The learning record is saved locally first;
class sync failures can be retried without interrupting the agent:

```bash
pi-student sync
```

See [docs/teacher-integration.md](docs/teacher-integration.md) for architecture,
Supabase Auth setup, the schema and RLS model, privacy boundaries, local/offline
behavior, and database test instructions.
