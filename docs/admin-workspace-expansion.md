# Admin workspace expansion

Implemented September 24, 2026. The platform, organization, and teacher applications share the existing authentication and authorization model.

- Platform Users supports searching, paging, editing names and email addresses, and deleting accounts. Deletion revokes access and anonymizes the profile while preserving historical records. Self-deletion, deleting the last platform operator, and deleting an organization's sole active owner are blocked. Failed Auth cleanup can be retried.
- Analytics shows platform adoption and session, token, model, and estimated-cost summaries, with date and organization filters. Unpriced usage is explicitly identified.
- Security supports review, dismissal, and resolution of domain mismatches, repeated authentication failures, and narrow chat safety signals. Signals are review leads, not determinations of wrongdoing.
- Organization class links open the shared teacher workspace under the administrator's own identity. Teachers and authorized organization administrators can remove active students, requiring fresh approval to rejoin.
- Project creation and editing include capabilities. Organization Settings includes checkboxes for delegating project controls; organization restrictions still apply. Controls already used in class/project policies cannot be locked until those overrides are removed.
- Skill and connector catalogs include the pinned Impeccable guidance bundle and Cloudflare Documentation MCP. Impeccable's Markdown guidance and references are accessible through the runtime; external CLI commands are not installed. Arbitrary custom connectors and secret-backed OAuth integrations are not automatically provisioned by this catalog.
- Model selection uses the bundled model registry with search, provider filtering, and supported reasoning options. Gateway credentials and model prices remain separately configured.

## Deployment and configuration

Database migrations through `20260924183600_capability_context_restrictions` and the `platform-admin-users` Edge Function were deployed to the linked Supabase project. The Edge Function verifies the bearer token with Auth and checks platform-administrator authorization for every action; gateway JWT verification is disabled to support current Auth signing keys.

Authentication-log synchronization requires the Edge Function secret `SUPABASE_MANAGEMENT_TOKEN`, scoped to read project logs. It is intentionally not copied from local CLI credentials. Until configured, the Security page displays that failed-login monitoring is disconnected. Refreshing Security imports groups of at least five authentication failures per IP and fifteen-minute interval from the last day; it stores a hash, count, time, and an account match only when the group identifies a single email. No background scheduler is installed.

Chat detection runs on new student prompts using narrow English rules for first-person self-harm or violence intent. Only category signals are stored; transcripts are not uploaded by this feature. It does not retrospectively scan chats or provide comprehensive moderation.

`AP CSP - Period F` is linked to `Test Organization`, preserving its members and projects. At verification, Test Organization had no approved models or delegated project controls. An organization administrator must select models, configure gateway credentials/prices, and choose teacher controls before using those managed features.

The three application packages must be restarted/redeployed from this checkout to serve the updated UI. Student runtime changes likewise require the updated client.

## Validation

- All 14 affected package builds passed.
- 81 application/runtime/adapter tests passed.
- 14 transactional database authorization tests passed, including organization-admin access, student removal, security signals, and account deletion restrictions. Fixtures were rolled back.
- The deployed Edge Function returned HTTP 401 without authentication.
- Browser checks used rendered application pages with fixture data; these do not substitute for a production authenticated smoke test.

Run `npx vitest run apps/teacher-console/test apps/org-admin/test apps/platform-admin/test packages/runtime/test packages/supabase-adapter/test` for the application suite. The database tests are in `infra/supabase/tests/admin_workspace_expansion.test.sql`.
