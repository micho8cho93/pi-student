# Teacher intervention queue

The teacher workspace's **Needs attention** page refreshes a queue for one authorized class at a time. The database checks that the caller is an assigned teacher before reading any sessions, and row level security restricts the queue to students that teacher may read. Each item names one student, project, and session. The teacher can inspect the session timeline, save a private note, dismiss, or resolve the item. Nothing messages or grades a student.

## Rules and priority

All current signals are deterministic. No DecisionEngine or Laya classification enters the queue, so a missing model or a disagreeing model cannot change an item.

| Signal | Minimum evidence | Priority |
| --- | --- | --- |
| Repeated test failures | Three recorded failures after the last recorded pass in one session | Medium; high at five |
| Agent edit balance | Three agent edit groups, at least 75% of recorded agent and student edit groups, and no recorded student revision of agent work | Medium |
| Missing reflection | A recorded pass, reflection required by the session policy, no confirmed reflection, and the session checkpoint older than 24 hours | Low |
| Ready for review | A recorded pass and confirmed reflection in one session, with no later recorded failure | Low |

Edit groups count recorded workspace events, not lines of code or quality. The teacher sees the exact counts and opens the session timeline before acting. Token counts never fire a signal. A fresh pass clears an open repeated-failure item; a confirmed reflection clears an open missing-reflection item. Dismissed and resolved items stay closed on later refreshes. The queue considers sessions from the last 30 days and closes open items older than 30 days.

The timeline does not record a stable test case identity, concept identity, or trustworthy active-work idle time. Therefore the queue does not claim repeated failure of the *same* test, repeated requests about the *same* concept, or a blocked student from inactivity. It also does not claim a milestone was completed. These require explicit, bounded provenance before they can become signals.

Queue evidence contains only generated counts and timestamps. The explanation is selected from a fixed set; raw prompts, file contents, commands, and test output are never copied into an intervention item. Teachers may write their own notes.
