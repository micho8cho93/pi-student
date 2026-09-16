# GitHub publishing architecture

Pi Student treats source control and deployment as one connected learning flow:

```text
Student Project
      ↓
GitHub Repository
      ↓
PublishingService
      ↓
HostingProvider
      ↓
GitHubPagesProvider
      ↓
Deployment metadata and history
      ↓
Live Website
```

The CLI (`pi publish` or `pi-student publish`) and the GUI call the same
`PublishingService`. The GUI reaches it through a loopback-only host bridge;
GitHub credentials stay in host-side credential storage and are never returned
to browser JavaScript, project code, the agent sandbox, logs, or project
metadata.

## Authentication and permissions

Clicking **Connect** opens a GitHub browser tab. Pi prepares a private,
version-pinned GitHub CLI helper automatically if one is not installed. Release
archives are checked against pinned SHA-256 checksums before extraction and
execution. No terminal setup is required. The UI displays GitHub's one-time
code, a copy button, and a fallback link if the browser blocks the new tab.
It polls sign-in progress and refreshes the account after authorization.

The helper manages credentials using GitHub CLI's credential storage (the OS
credential manager where available, with GitHub CLI's file fallback otherwise).
Credentials never pass through browser JavaScript. Git authentication is
configured automatically after sign-in, including the private helper path.
GitHub CLI requests its baseline `repo`, `read:org`, and `gist` scopes, plus
`public_repo` and `workflow` for publishing. The UI shows errors and allows a
retry when authorization fails or expires.

Production distributions should point this same `GitHubClient` boundary at a
GitHub App user-to-server flow. Recommended repository permissions are:

- Metadata: read
- Contents: read/write
- Pages: read/write
- Workflows: write only when framework deployment is enabled
- Administration: only if the installation's repository-creation path needs it

Use short-lived user access tokens and keep token exchange and refresh on the
host/backend. The UI consumes only account, repository, and deployment DTOs.

## Publish behavior

`PublishingService` detects static HTML sites and supported Node-based static
frameworks. A plain site publishes directly from the current branch (normally
`main`) and gets a `.nojekyll` file. Vite, React, Astro, and Svelte projects with
a build script get a Pi-managed `.github/workflows/pi-pages.yml` workflow. An
existing workflow at that path is never overwritten.

Before the first public repository is created, the caller must provide explicit
consent. CLI automation may use `--yes` only after presenting that policy in its
own UI. Future school policy can implement the same confirmation callback to
deny publishing, limit providers, require approval, or disallow public
repositories without changing the provider or views.

Publishing is idempotent. Saved repository metadata or a valid existing GitHub
`origin` is reused. Pi never force-pushes, replaces an unrelated remote, changes
existing history, or publishes a subfolder from a larger Git repository.
Subsequent publishes commit only when files changed.

The pre-publish check respects `.gitignore`, generates a conservative one when
none exists, blocks sensitive file types and common token patterns, and limits
all file operations to the selected project root. `.env`, private-key files,
dependency directories, and build output are excluded by the generated ignore
file.

## Metadata and sidebar state

Per-project state is stored with mode `0600` under
`~/.pi-student/config/projects/`, keyed by a hash of the canonical project path.
It contains no credentials. The model links:

- project path and display name;
- GitHub owner, repository, URL, and branch;
- provider id and label;
- branch or Actions deployment type;
- current status, live URL, last error, and recent deployment history;
- whether the generated workflow is Pi-managed.

`readEcosystemState` combines this local source of truth with a small live
Git/GitHub snapshot. Both sidebar quick views and full detail panels use that
same state. The current project's repository and deployment are surfaced first.
The local bridge accepts only the Pi GUI origin, requires a custom header for
mutations, binds to `127.0.0.1`, and never accepts a client-provided project
path.

## Adding a hosting provider

Implement the `HostingProvider` interface in `packages/publishing/src/types.ts`:

```text
publish → configure the first deployment
update → update an existing deployment
getStatus → return provider-neutral build state
getDeploymentUrl → return the public URL
remove → remove hosting when supported
```

Then inject it into `PublishingService`. Keep provider-specific API values out
of the GUI; map them to Pi's `preparing`, `building`, `deploying`, `published`,
and `failed` states. Repository management remains a separate boundary, so a
future Pi Hosting, Cloudflare, school, or on-prem provider can reuse the
metadata, command, navigation, and deployment views.

## Testing

Unit tests use a fake `GitHubClient` and intercept only `git push`; they never
create real GitHub resources. Tests cover detection, first and later publishes,
Pages modes, workflow preservation, consent, failure history, `.env` exclusion,
secret detection, repository naming, and remote validation.
