# Teacher Integration MVP

Pi Student's teacher integration is an optional educational-observability layer. It records structured evidence about a learning session, not a transcript or repository snapshot. The coding agent and sandbox continue to work when Supabase is unconfigured, the network is offline, or a student has not joined a class.

## Architecture

```text
Pi core ── terminal UI / future GUI
   │
   ├── typed LearningEventBus
   └── Pi event adapter
          │
      SessionRecorder
          │
      LearningRecordStore (local, first)
          │
      LearningRecordSyncService (optional/retryable)
          │
      Supabase Auth + Postgres RLS
          │
      local teacher dashboard
```

The reusable boundary is `src/telemetry/`. Interface code emits or adapts events; it does not construct database rows. `SessionRecorder` is deterministic and has no network dependency. `LearningRecordSyncService` accepts an uploader function so it can be tested without Supabase and replaced by another hosted service later.

The existing Pi extension API was the cleanest integration point. It already exposes model selection, thinking-level changes, provider usage, tool calls/results, and session shutdown for both terminal modes. The adapter checks file existence before successful `write`/`edit` calls to distinguish created from modified files. It records counts only—never paths or contents.

## Events and learning records

The small typed event set lives in `src/telemetry/events.ts`. It includes session lifecycle, class/project selection, models, thinking level, file/test activity, assistance evidence, student decisions/blockers/questions, and confirmed reflection.

Each completed meaningful session produces one versioned record containing:

- session identity, class/project links, timestamps, duration, and goal;
- unique providers/models, thinking mode, agent turns, and token totals;
- aggregate file and test counts;
- requirement and standard IDs, student-recorded decisions, blockers, questions, and next step;
- categorical planning, implementation, debugging, and explanation assistance;
- the student's confirmed reflection, when provided.

The record intentionally excludes prompts, responses, full transcripts, source text, filenames, `.env` contents, API keys, provider credentials, sandbox secrets, and AI-provider OAuth tokens.

The agent records structured learning evidence during a session. Assistance levels use deterministic counts: one occurrence is low, two moderate, and three or more high. File-writing raises implementation assistance; test/build/lint execution raises debugging assistance; guided planning and explanations are based on the active pedagogical stage. These labels are descriptive and are never grades.

## Reflection

When a meaningful session shuts down, Pi asks the student whether to complete the normal four-question reflection. Each answer is entered by the student. Pi then shows the complete reflection and requires confirmation. Choosing No restarts editing; cancellation saves the session without attributing an unconfirmed reflection to the student.

## Local and offline behavior

Records are written atomically with owner-only permissions under:

```text
${PI_STUDENT_HOME:-~/.pi-student}/learning-records/<session-id>.json
```

Records begin as `pending`. A stable UUID and database upsert make uploads idempotent. Successful uploads become `synced`; failures remain pending with a redacted error and attempt count. Run `pi-student sync` to retry. Records without a class remain local and are skipped by sync.

## Supabase setup

The reproducible schema is in `supabase/migrations/20260913083923_teacher_integration_mvp.sql`; the conversational brief is added by `supabase/migrations/20260913183002_project_brief_and_alignment.sql`. Apply both with your normal Supabase migration workflow. Current Supabase projects may not expose new public tables to the Data API automatically, so the migration includes explicit least-privilege grants as well as RLS.

Configure these environment variables for the CLI and local dashboard:

```bash
export PI_STUDENT_SUPABASE_URL="https://YOUR_PROJECT.supabase.co"
export PI_STUDENT_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."
```

When running from the repository, the same values may be placed in the
gitignored `.env.local`; Pi Student loads that file automatically.

The publishable key is intended for public clients and is safe only in combination with the included grants and RLS. Never use `service_role`, a secret key, a database password, or an AI-provider key here.

In Supabase Auth:

1. Keep email magic-link sign-in enabled.
2. Add `http://127.0.0.1:4173/auth/callback` and the CLI callback pattern `http://127.0.0.1:*/auth/callback` to allowed redirect URLs for local development (use the exact deployed dashboard callback URL in production).
3. Enable Google under Auth → Sign In / Providers and configure a Google Web OAuth client. Add Supabase's provider callback URL—not the local Pi Student URL—to the Google OAuth client's authorized redirect URIs. The local config includes the provider block; set `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET` before `supabase start`.
4. If email delivery reports a rate-limit error, wait for the per-address cooldown or configure custom SMTP. Supabase's built-in email service is intentionally limited; the local config permits more attempts for development, but it cannot raise a hosted project's delivery quota.

The CLI stores only the Supabase user session locally in `~/.pi-student/config/supabase-auth.json` with mode `0600`. It is not exposed to the model or sandbox.

## Authentication and class joining

One `auth.users` identity receives one `profiles` row. Teacher permissions come from `classes.teacher_id`; student access comes from active `class_members` rows. No editable user metadata or client-side role flag is used for authorization.

Teacher flow:

```bash
pi-student teacher
```

This opens the keyboard-first terminal dashboard by default; `pi-student teacher
tui` is an explicit alias. It exposes the same Classes, Today, Students, Projects,
and student Today/Week/Project views as boxed terminal cards. Every visible card
or section has a number, and short commands handle navigation and actions. The
browser dashboard runs alongside the TUI without opening automatically, with its
copyable localhost URL pinned in the top card on every screen; the `web` command
opens it. Use `pi-student teacher web` for the browser-only dashboard.

The terminal dashboard also supports `/dictate` for speaking a dashboard
command and `/dictation` for guided provider setup. Dictation is deliberately
terminal-only and is not exposed by the localhost browser dashboard.

Sign in with Google or an email magic link, create a class, and share its six-character join code. The dashboard now uses an explicit `/auth/callback` route for both providers and offers email-code verification when the configured email template includes a six-digit OTP. Codes are generated with cryptographic randomness, can expire, can be paused, and can be regenerated. The `join_class` database function limits each signed-in user to ten attempts per fifteen minutes. Valid joins create a `pending` student membership; the teacher approves or rejects it in the dashboard.

The core teacher workflow is also available without opening the dashboard:

```bash
pi-student teacher auth login google
pi-student teacher auth login email teacher@example.edu
pi-student teacher auth verify email teacher@example.edu 123456
pi-student teacher class create "AP CSP — Period 2"
pi-student teacher class list
pi-student teacher class members <class-id>
pi-student teacher class approve <membership-id>
pi-student teacher project create <class-id> "Weather app"
pi-student teacher project requirement <project-id> "Use at least one data source"
pi-student teacher project standard <class-id> <project-id> CRD-2.B "Develop an algorithm"
pi-student teacher project list <class-id>
```

Student flow:

```bash
pi-student auth login email student@example.edu
# or: pi-student auth login google
pi-student class join ABC-234
pi-student class list
pi-student class select <class-id>
pi-student project list
pi-student project select <project-id> --requirements <id,id>
```

Selecting a project automatically selects its linked standards. Requirements remain an explicit choice so the record does not overclaim work the student did not do.

## Relational model

- `profiles`: one row per Supabase identity.
- `classes`: teacher ownership plus join-code lifecycle.
- `class_members`: teacher/student role, `pending`/`active`/`rejected` status.
- `projects`, `project_requirements`, `standards`, `project_standards`: teacher-authored educational context.
- `sessions`: structured aggregate telemetry and learning evidence.
- `session_requirements`, `session_standards`: filterable many-to-many evidence links.
- `session_reflections`: confirmed student-authored statements.
- `private.join_attempts`: non-exposed rate-limit state.

## RLS model

Every table has RLS enabled, including the private rate-limit table. `anon` receives no table privileges. `authenticated` receives only the operations used by the product.

- A student can read their own profile, memberships, sessions, links, and reflections; read class projects after membership approval; and insert/update only sessions and reflections whose `student_id` equals `auth.uid()`.
- A teacher can read and manage classes they own, their memberships, project metadata, and records only when both the class is teacher-owned and the session student has active membership in that class.
- Students have no direct membership insert privilege. The narrowly granted `join_class` RPC always derives the student from `auth.uid()` and always assigns the `student` role.
- Privileged helper functions live in the unexposed `private` schema, have fixed empty search paths, and are not callable by anonymous users. Public security-definer RPCs are explicitly revoked from `PUBLIC` and granted only to authenticated users after in-function identity/ownership checks.

`supabase/tests/teacher_rls.test.sql` covers class creation, positive and negative cross-student and cross-teacher access, join-code states, approval, impersonation, and self-promotion. Run it against a local Supabase stack with:

```bash
supabase start
supabase db reset
supabase test db
```

## Dashboard

The dashboard is intentionally small and read-oriented:

1. **Classes** — create/open a class, see student counts and code state.
2. **Daily activity** — active students, sessions, time, models, tokens, file counts, projects, assistance, and descriptive attention signals.
3. **Student detail** — today/week/project views with goals, requirements, standards, decisions, blockers, usage, assistance, and reflection.

Project creation is conversational in both teacher surfaces. The terminal TUI's
Projects → `new` flow and the browser Projects → Add project flow use the same Pi
model credentials to ask clarifying questions and produce a structured brief with
a goal, learning objectives, expectations, structure, constraints, success
criteria, requirements, and any named standards. The browser builder endpoint
accepts only an authenticated teacher's class, and the saved brief is the only
project-conversation output persisted. Teachers can edit the saved brief manually
later.

When a student selects a project, Pi receives the full brief in its assignment
context. If a student proposes a materially different project, the agent names
the conflicting goal or expectation and asks whether to connect the idea back to
the assignment or seek a teacher-approved scope change; it does not silently
pivot the work.

Teachers can approve/reject membership, pause or regenerate join codes, and create projects, requirements, and standards. They can configure capabilities separately for each project. They cannot run commands remotely, inspect sandboxes, browse source code, read raw transcripts, message students, grade, or rank students.

## Project capability controls

Open a project's **Edit details → Project capabilities**, or use `controls <project number>` in the teacher terminal's Projects view. Apply `20260914050931_project_capability_controls.sql` before running this version. Existing projects retain the current defaults.

Teachers select any nonempty combination of reasoning levels. Students can use only the intersection of those levels and their model's supported levels. Approved model IDs can specify one model, a list, or unrestricted selection. Independent switches govern file editing, terminal commands, dependency installation, sandbox internet access, Desktop export, image/file attachments, and reflection. Optional session limits cover minutes, model responses, tokens and estimated USD cost. Token and cost limits are checked after each response, so the final response can exceed the budget.

Accessibility is a separate settings group: dictation, cloud transcription, read aloud, simplified vocabulary and readable formatting. It never enables editing or other restricted tools. Cloud transcription can be disabled while retaining local dictation. `/read-aloud` uses an installed system voice (macOS `say`, Linux `espeak`); unavailable voices produce a notice rather than breaking the conversation. Dictation still inserts editable text and keeps the existing consent and audio cleanup behavior.

The policy is loaded when a project is selected or a session starts. An existing cached project policy remains usable offline; when no policy is available, reconnect with `/projects` before continuing project work. Selecting a new project/version starts a separate learning record. Each project record stores the effective version and settings, plus aggregate runtime-reported blocked-action counts. Policy snapshots cannot be rewritten by later project edits. No conversation text, source files or audio are added to teacher telemetry, and the counts are not grades or tamper-proof attestations.

These controls govern the Pi Student conversation. Paseo's existing generic host terminal/Git screens are outside that runtime (see the README's GUI limitation). File attachment controls reject Paseo attachment references before model processing; they do not delete files already uploaded to its local daemon. With file editing or dependency installation disabled, shell commands are limited to inspection so scripts cannot bypass those settings. Readable formatting and vocabulary are LLM instructions; model selection and tool permissions are runtime checks.

## Future extension points

A future GUI can subscribe directly to `LearningEventBus`, reuse `SessionRecorder`, and render the same reflection controller. More reliable framework-specific test detection can be added at the Pi adapter without changing storage. Standards inference can build on project requirement links, but automated grading and silent generation of student claims remain outside this architecture.
