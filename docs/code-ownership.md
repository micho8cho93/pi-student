# Code ownership

`.github/CODEOWNERS` uses the repository owner's valid GitHub account today. The intended stewardship areas are recorded separately so adding real teams later does not require rediscovering boundaries.

| Area | Conceptual owner | Responsibility |
| --- | --- | --- |
| `packages/runtime`, `packages/sandbox*` | runtime | Pi integration, lifecycle, isolation |
| `packages/education`, `packages/classroom` | learning / education-platform | pedagogy and classroom domain |
| `packages/policy`, `packages/contracts`, `packages/sdk`, `packages/telemetry` | platform | stable contracts, enforcement, records |
| `packages/publishing` | integrations | deployment workflow and providers |
| `packages/supabase-adapter`, `infra/supabase` | platform integrations | backend adapter and schema |
| `packages/paseo-adapter`, `apps/client` | client | installed client and GUI bridge |
| `apps/teacher-console` | education application | teacher-facing presentation |

When GitHub teams exist, replace the account in CODEOWNERS with valid team handles matching these areas. Do not add placeholder handles: invalid owners make review routing unreliable.
