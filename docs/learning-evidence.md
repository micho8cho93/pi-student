# Learning Evidence and activity timeline

`deriveLearningEvidence` is a deterministic projection of the existing workspace journal and a confirmed session reflection. The projection runs at the session checkpoint and on the student's `/timeline` command. Synced rows in `learning_evidence` are a replaceable cache tied to the existing `sessions` row. The workspace journal and workflow controller remain the sources of execution truth.

## Contract

Each event has a stable hash ID, timestamp, project and session IDs, category, actor, source (`observed`, `deterministic`, or `classified`), a short generated summary, and source event IDs. No classified evidence is currently emitted. The `confidence` field is reserved for future classified events and must be present when `source=classified`.

## Derivation

- Editor `file.changed`, agent `agent.files_changed`, and `autocomplete.accepted` retain separate authorship. Repeated edits to one file within two minutes collapse into one item. A debounced editor change immediately after accepting AI completion is suppressed as a duplicate.
- A student editor change after an agent change to the same file produces a deterministic revision relationship. The summary reports the observed ordering; it does not assess the revision's quality.
- A failed test, subsequent student edit, and later passing test produce a temporal sequence. The summaries deliberately say “edited after” and “passed after” because the journal cannot prove the edit caused the pass.
- A transition in `learning.progress.planApproved` records plan approval. The first observed approved snapshot is not treated as a new approval.
- `chat.prompted` with `learnMode=true` records actual Learn Mode use. `question.completed` records `/question` completion. A confirmed session reflection contributes a metadata-only reflection item.
- Project events have no native session ID. They are associated with the recording session by its time window; concurrent sessions can make that association ambiguous. Chat, Learn Mode, question, and workflow events are filtered by their actual workspace session ID.

The stream uses a stable `sourceId` across journal replays, so rebuilding from the same retained records yields the same evidence IDs. The synced projection is replaced atomically for a session. Journal retention and the 200-item evidence cap limit how far back a local rebuild can go; previously synced rows can be replaced by a later shorter projection if old source events have rotated out. A future archival source would be needed for complete historical rebuilds.

## Access and privacy

The teacher view follows Class → Project → Student → Day / Session. The student sees the recent timeline with `/timeline`. The database uses the same active class membership check as session records: the student may replace their own session evidence, and an assigned teacher may read it. A different class's teacher cannot read it. The replacement RPC runs as the caller under RLS.

The projector reads only event type, timestamp, provenance, file basename, actor surface, and bounded workflow flags. It never copies commands, test output, file contents, prompts, question topics, or reflection text. Sensitive file events are dropped. Database constraints allow only fixed summaries or safe filename summaries and structured source IDs, preventing arbitrary code or terminal text in the teacher timeline.

## Evidence gaps

`chat.prompted` contains no prompt text or intent label, so the pipeline does not label conceptual help, debugging guidance, implementation help, student explanations, or quality of understanding. The `DecisionEngine` is not used on this metadata: a probabilistic label would be unsupported, and no Laya result is promoted to fact. Explicit intent events or student-confirmed statements would be needed to add those categories. Failed test → edit → pass is a time relationship, not proof of a correct fix. Historical sessions created before this projection have no workspace timeline until their retained local events are rebuilt and synced.
