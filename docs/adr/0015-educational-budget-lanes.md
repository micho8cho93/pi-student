# 0015: Educational AI budget lanes

## Decision

Students see one budget, `WorkspaceBudgetState`, with five lanes: `overall`, `agent`, `tutoring`, `autocomplete`, and `architecture`. Each lane is `available`, `low`, `exhausted`, or `unavailable`. The state is computed from existing accounting and stores no usage of its own. Session counters stay in `CapabilityState`. Monthly usage stays in the organization ledger and reaches the client through model admission. See [workspace-budget.ts](../../packages/runtime/src/workspace-budget.ts) and [budget.ts](../../packages/contracts/src/budget.ts).

Lanes close in a fixed order, so the AI stops doing the work before it stops helping:

```text
AI doing (agent)  →  AI assisting (tutoring, autocomplete, architecture)  →  student doing (manual)
```

The editor, the student's terminal, and tests are not budget lanes and are always available. Students see availability, such as "AI implementation: used up for now". They do not see token counts. Teachers and admins set the numbers. `WorkspaceBudgetState.session` carries the low-level remaining values for teacher and diagnostic surfaces.

### Two reserve mechanisms, one per accounting system

**Session policy (`limits.tutoringTurns`).** This setting follows the existing hierarchy: organization → class → project → session. Delegation rules apply, and the smallest value wins. `limits.minutes` and `limits.turns` now limit agent execution only. When either is reached, the session switches to tutoring mode:

- The active tool list is cleared.
- The system prompt tells the model to guide the student without writing the solution.
- Tool calls are blocked as a second line of defense.

The student can then get `tutoringTurns` more responses. `null` means no separate cap; token and cost limits still apply. `limits.tokens` and `limits.cost` still stop all AI.

**Organization monthly budgets (`assistance_reserve_fraction`).** A budget row can keep a fraction of its cap for tool-free requests. Agent requests stop at `1 − reserve`. Tool-free requests continue until the full cap. The gateway decides whether a request is agent work from the request itself: a non-empty `tools` or `functions` array means agent work. It does not trust a purpose the client declares. Tutoring mode sends no tools, so tutoring requests pass the gateway's check without extra client cooperation. `check_model_budget` returns `agentBlocked` next to `blocked`. Older clients read only `blocked` and keep their previous behavior, while the gateway still enforces the reserve.

### Admission is purpose-aware

`ModelAdmissionProvider.check(..., purpose)` accepts `agent`, `tutoring`, `autocomplete`, or `architecture`. Autocomplete and flowchart generation go through the same `ModelAdmissionGate` with their own purpose. Chat is admitted as `tutoring`. If only the agent lane is blocked, the runtime sets `CapabilityState.agentBlocked`, which puts the session in tutoring mode. It does not end the conversation.

## Quota inventory

| Quota | Where | Category | Lane / effect |
|---|---|---|---|
| Monthly cost/token cap per organization, class, user, model | `organization_budgets`, gateway reservation | Cost limit (authoritative) | `overall`; the reserve fraction closes `agent` first |
| `assistance_reserve_fraction` | `organization_budgets` | Educational limit on a cost budget | Closes `agent`, keeps tool-free lanes |
| Budget `hard_action` (`block_ai`, `block_model`, `fallback`) | `organization_budgets` | Cost limit | `overall`, or model switch |
| Unknown price or unreported prior cost with a cost cap | gateway RPC | Cost limit (fail closed) | `overall` |
| Session `limits.tokens`, `limits.cost` | `CapabilityPolicy` → `CapabilityState` | Cost limit | `overall` |
| Session `limits.minutes`, `limits.turns` | `CapabilityPolicy` → `CapabilityState` | Educational limit | `agent` |
| Session `limits.tutoringTurns` | `CapabilityPolicy` → `CapabilityState` | Educational limit | `tutoring` |
| Approved models, providers, reasoning levels | policy, `approved_model_profiles` | Policy (not a quota) | capability denial, not a lane |
| Gateway input bound (32k), output bound (4,096), 1 MB body, text only | `services/model-gateway` | Provider limit and abuse protection | request rejected |
| Provider 429 / overload | upstream | Provider limit | one-time fallback model |
| Autocomplete 10/min and 100/day per workspace | `EditorCompletionService` | Local abuse and performance protection | request rejected; not reported as budget |
| Autocomplete 160 output tokens, 8 s timeout, 50k-char file | `EditorCompletionService` | Performance limit | request rejected |

## Consolidation

Autocomplete and flowchart generation already called model admission. They now pass their purpose, so they use the same budget system as chat. The admission hook type (`ModelAdmissionGate`) is defined once instead of being repeated in three signatures. The local autocomplete counters remain. They stop runaway editor loops and request storms, which the monthly budget cannot catch in time. They also run for personal providers, which the organization does not meter. They are not treated as a budget and never mark a lane exhausted.

## Consequences

- Behavior change: a teacher's "responses" or "minutes" limit no longer stops all AI. After the limit, the AI can explain but cannot edit files or run commands. Teachers who want a hard stop should use token or cost limits, or set a small `tutoringTurns`.
- Policies saved before this change stay valid, because `tutoringTurns` is optional in both the TypeScript parser and `validate_capability_policy`.
- The gateway reserves the worst-case request size. A tool-free request can therefore be refused near the end of the reserve even if its actual cost would fit (see ADR 0011).
- The bridge's `/workspace-actions` shows the most recent admission decision for that workspace. Its lane status can be stale until the next autocomplete or flowchart request.
