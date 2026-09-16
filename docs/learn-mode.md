# Learn Mode

Learn changes Pi's objective inside the existing conversation. The project,
editor, terminal, sandbox, model, thinking level and implementation stage stay
in place. It creates no workspace, dashboard, navigation destination or chat.

## Usage

- Click **Learn ○ / Learn ●** beside the existing thinking control. On compact
  controls or models without reasoning, it sits beside the available controls.
- Ask “Teach me this codebase”, “Show the architecture”, “What starts at runtime?”,
  “Trace login”, or “Go deeper into this function”. Explanations and text diagrams
  appear in ordinary chat; source references use the existing file-link surface.
- Learn permits inspection, not proactive edits. Switch it off for implementation.
- In the terminal, `/learn`, `/learn on`, and `/learn off` change the same setting.
- `/question [easy|medium|hard] [topic]` starts one repository-grounded question.
  The next answer receives feedback, then the prior mode resumes. `/question off`
  exits early. Learn itself never starts a question or requires an answer.

Preferences persist across restarts for the same Pi session. A new conversation
starts with Learn off. An in-flight response retains its mode; toggles affect the
next prompt. No prompt is sent merely by toggling Learn.

## Implementation

### Session and policy

`packages/education/src/settings.ts` stores a host-owned boolean under
`$PI_STUDENT_HOME/config/chat-settings`, keyed by a hash of project path and Pi
session ID. Atomic file replacement prevents partially written preferences.
No preferences or analysis files are written into the student's repository.

`packages/education/src/extension.ts` synchronizes the setting before each agent request and
before legacy question preparation. `LearningSession.learnMode` is the active
turn's policy state. `LearningSession.question` holds explicit practice difficulty,
topic and generation/answer phase. The workflow controller filters existing
allowed inspection tools and exposes `codebase_model`, disabling editing,
student questions, stage transitions, plans and exports while exploring. Existing
sandbox, capability, model/provider and shell-policy checks remain active.

The normal educational implementation prompt and question-preparation hook are
skipped in Learn/question turns. Switching off restores the existing stage's
tools; it never resets the workflow or changes the thinking setting.

### Codebase model

A session owns one `CodebaseModel`, shared by Learn and `/question`:

- Initial discovery lists at most 60 directories, 200 entries per directory,
  1,200 files and four directory levels. Generated dependencies and hidden paths
  are excluded. It reads at most 24 recognized manifests, not every source file.
- Facts include languages, categorized technologies, package boundaries, declared
  and candidate entry points, scripts, directories, patterns and relationships.
- `search` returns relevant filename candidates; existing grep/read tools support
  content searches and deeper files outside discovery coverage.
- `inspect` extracts source symbols, route candidates, import evidence and line
  references. It retains at most 32 inspected source summaries and returns a
  numbered excerpt. Changed sources replace their old import edges.
- `map` renders observed relationships as a text diagram. `trace` follows local
  imports through at most eight source files, handles cycles and reports unresolved
  dependencies. These are dependency traces, **not proofs of runtime call order**.
  Pi reads the actual code to explain execution and data flow.
- The model is reused for 60 seconds. The next retrieval then refreshes discovery
  and manifests, retaining explored facts only when their content hash matches.
  Explicit `refresh` is available. Normal-mode edits/shell activity invalidate it.
- Coverage limits, read failures, inferred entry points and unresolved edges are
  reported. Repository content is evidence, never an instruction source for the tool.

### GUI integration

The existing Paseo shell patch adds an accessible pressed-state button. A small,
version-checked bundle adapter exposes the actual agent ID from the existing
AgentControls component. This avoids guessing which chat is selected, including
when a workspace has multiple conversations. React retains its own composer and
reasoning controls. The button handles pending saves, failures and chat changes.

The existing localhost ecosystem bridge serves GET/POST `/learn-mode`. It resolves
workspace and Pi session identity through Paseo's registries, checks project and
provider membership, then reads/writes the same settings store used by the terminal.
It retains the bridge's origin and custom-header checks. No model credentials or
repository content traverse this endpoint. GUI polling also reflects terminal
setting changes. Newly initialized sessions must have a registered Pi identity
before the button becomes enabled.

After upgrading, an already running older ecosystem-bridge process must be stopped
before relaunching the GUI. The launcher reports this condition rather than exposing
a toggle whose endpoint does not exist. No running user sessions were restarted
as part of this implementation.

## Files

Added:

- `packages/education/src/settings.ts`
- `packages/education/src/project-model.ts`
- `packages/education/src/extension.ts`
- `packages/paseo-adapter/src/paseo-session.ts`
- `packages/paseo-adapter/src/learn-controls-patch.ts`
- `packages/education/test/learn-mode.test.ts`
- `packages/paseo-adapter/test/learn-controls.test.ts`
- `packages/paseo-adapter/test/learn-bridge.test.ts`
- `docs/learn-mode.md`

Modified for this feature:

- `packages/runtime/src/create-session.ts`
- `packages/education/src/types.ts`
- `packages/education/src/workflow-controller.ts`
- `packages/runtime/src/student-ask.ts`
- `apps/client/src/terminal/slash-commands.ts`
- `apps/client/src/terminal/repl.ts`
- `packages/paseo-adapter/src/web-ui.ts`
- `packages/paseo-adapter/src/launcher.ts`
- `packages/paseo-adapter/src/ecosystem-bridge.ts`
- `README.md`

Pre-existing publishing and GUI edits in the working tree were preserved.

## Validation and limits

Final validation: build passed; all 222 tests across 44 test files passed;
`git diff --check` passed. There are 19 new deterministic tests.

- `npm run build` — TypeScript compilation/type checks.
- `npm test` — complete Vitest suite, including representative Python, React,
  client/server, monorepo and incomplete repositories; caching; refresh; dependency
  cycles; session isolation; terminal parity; difficulty; quiz lifecycle; custom
  tool restrictions; bridge authorization and installed bundle syntax/idempotence.
- Browser checks use the production injected script in an isolated composer fixture:
  rendering, toggle, unchanged draft/thinking/URL and switching chat identity.
  They do not call a live LLM or restart the user's active Paseo daemon.
- No lint script is configured in this repository.

Analysis is a bounded heuristic foundation, not a complete language server or
runtime profiler. Aliases, dynamic imports, generated routes, complex Python
imports and interprocess call chains may require targeted reads and explanation.
Architecture motivations and runtime order must remain labeled as inferred unless
code supports them. Source extraction is optimized for JS/TS and Python; other
languages receive manifest/language detection and normal source inspection.
The cache is in memory and rebuilds lazily when a session process restarts.
Manifest/source size limits are checked after the sandbox's existing readFile API
returns; this API does not currently offer bounded byte reads.
Question generation and semantic grading use the selected provider; deterministic
tests deliberately do not assert exact LLM prose or pedagogical quality.
