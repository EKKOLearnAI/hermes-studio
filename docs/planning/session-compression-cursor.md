# Session Compression Cursor Plan

Date: 2026-07-19
Issue: https://github.com/EKKOLearnAI/hermes-studio/issues/2138

## Context

Live chat and History already load recent messages in bounded pages. The server
still has hidden full-history work when a session is resumed and when a
compression snapshot is applied.

Compression snapshots currently store `last_message_index`. The compressor
reconstructs the complete ordered context array and uses that index with
`slice()` to find the messages that have not yet been folded into the summary.
This makes the snapshot boundary dependent on an in-memory array and causes an
existing snapshot to load old message bodies that the model will never receive
again.

The current resume path also builds the full DB history to calculate context
usage, then performs another full session-detail query to obtain lightweight
metadata such as the workspace and parent-session fields. Those operations are
not required to render the latest message page.

The optimization must preserve the purpose of context compression: the first
protected messages remain verbatim, the summary represents a precise prefix of
the context history, and the uncompressed tail begins immediately after that
prefix without losing or duplicating a model-visible message.

## Goals

- Replace array-position compression boundaries with a stable database cursor.
- Build an existing snapshot's effective model context from a bounded head,
  its summary, and only messages after the cursor.
- Keep the first compression accurate even though it must inspect the complete
  unsummarized history.
- Remove full-history reads and tokenization from session open, switch, and
  reconnect paths.
- Preserve tool-call/tool-result pairs and protected head/tail windows across
  compression boundaries.
- Invalidate or remap snapshots correctly when history is cleared, deleted,
  edited, imported, or copied into a branch.
- Keep the user-visible chat and History pagination behavior unchanged.

## Non-Goals

- Do not implement this plan as part of the planning change.
- Do not replace `node:sqlite` solely for this optimization.
- Do not move all persistence to a Worker Thread in the first implementation.
- Do not archive or delete old messages after they are summarized.
- Do not change compression prompts, summary budgets, or configured context
  thresholds unless required by a separate change.
- Do not make the first summary without reading the content that must be
  summarized.

## Current Behavior

### Snapshot Representation

`chat_compression_snapshots` stores:

```text
session_id
summary
last_message_index
message_count_at_time
updated_at
```

`last_message_index` is an index into the normalized context history, not a
stable identity for a database message. Incremental compression reconstructs
the full array and selects:

```ts
history.slice(snapshot.lastMessageIndex + 1)
```

`message_count_at_time` is persisted but is not currently used to validate the
snapshot. Snapshot usability is primarily a bounds check against the newly
constructed array.

### Resume Flow

On a cold Socket.IO resume:

1. The latest message page is loaded for display.
2. The complete context history is loaded and normalized.
3. Snapshot-aware context is assembled to calculate `contextTokens`.
4. Full session detail is loaded again for workspace and parent metadata.
5. Only the paginated state is emitted to the client.

The full arrays created in steps 2 and 4 are temporary, but their synchronous
SQLite reads, row mapping, JSON parsing, and token counting still execute on the
server event loop.

### First And Incremental Compression

The first compression needs the full unsummarized range because that content
must be sent to the summarizer. After a snapshot exists, the effective context
is conceptually:

```text
[protected head] [summary through boundary] [preserved tail and new messages]
```

Only the current index-based representation requires the already summarized
middle section to be loaded again.

## Proposed Design

### Stable Message Cursor

Add a stable boundary to the snapshot:

```sql
ALTER TABLE chat_compression_snapshots
  ADD COLUMN compressed_through_message_id INTEGER;

ALTER TABLE chat_compression_snapshots
  ADD COLUMN history_revision INTEGER NOT NULL DEFAULT 0;
```

`compressed_through_message_id` is the ID of the last context message whose
content is represented by `summary`. Message ordering must continue to use the
same database order as context construction, currently message `id`, rather
than timestamp.

Keep `last_message_index` temporarily for legacy snapshots and diagnostics. New
snapshot writes should use the cursor as the source of truth. Keep
`message_count_at_time` as optional validation and observability data, but do
not use a count as the boundary identity.

### Cursor-Carrying Context Entries

Preserve database identity while normalizing messages:

```ts
interface ContextHistoryEntry {
  cursorId: number
  message: ChatMessage
}
```

The cursor is internal metadata and must not be sent to the model. Filtering
invalid or non-context rows must keep each surviving `ChatMessage` attached to
its original database ID. The compressor should return the cursor of the last
entry folded into the summary instead of returning only an array index.

This avoids deriving a database boundary from the length of a transformed
array, which can differ from raw row count when roles are filtered, assistant
messages are rejected, or tool-call metadata is normalized.

### Snapshot-Aware Context Query

For a valid cursor snapshot, query only the protected head and the range after
the boundary:

```sql
SELECT *
FROM messages
WHERE session_id = ?
ORDER BY id
LIMIT ?;
```

```sql
SELECT *
FROM messages
WHERE session_id = ?
  AND id > ?
ORDER BY id;
```

Apply the same context-message normalization used by the full-history path.
The model context becomes:

```ts
[
  ...protectedHead,
  summaryMessage,
  ...messagesAfterCursor,
]
```

The head query may need to read slightly more than `protect_first_n` raw rows
until it obtains the requested number of valid context entries. This remains a
small bounded query.

### Incremental Compression

When the snapshot-aware context exceeds the compression threshold:

1. Treat `messagesAfterCursor` as the incremental range.
2. Keep the configured last N messages verbatim.
3. Fold the earlier part of the incremental range into the existing summary.
4. Save the database ID of the final folded entry as the new cursor.
5. Retain the previous cursor when no incremental entry is summarized.

The token decision must be based on the exact effective context sent to the
model: protected head, summary, and post-cursor range. Tokenizing the already
summarized middle section is unnecessary and would produce the wrong decision
surface.

If the post-cursor range grows unusually large before compression runs, read it
in bounded batches. Batching should limit temporary memory without changing
message order or compression semantics.

### First Compression

Without a snapshot, load the complete normalized context history. The first
summary cannot be accurate without reading the content it represents.

When full compression selects the protected tail, save the ID of the message
immediately before that tail as `compressed_through_message_id`. If no message
is successfully summarized, do not create or advance the snapshot cursor.

### Turn-Aware Boundaries

Do not advance a cursor into the middle of an assistant tool call and its tool
results. Before finalizing a compression range:

- keep an assistant `tool_calls` message with all corresponding tool results;
- do not start a post-cursor range with an orphaned tool result;
- keep existing fallback inference for legacy rows missing `tool_call_id`, or
  normalize those relationships before choosing the boundary;
- move the boundary backward when the desired cut would split a logical turn.

The cursor must identify the final database row of the complete folded turn,
not merely the row at a desired numeric tail size.

### Snapshot Validation And History Revision

Append-only writes do not invalidate a cursor. Destructive or rewriting
operations must invalidate it transactionally.

A snapshot is usable only when:

- its `history_revision` matches the session revision;
- its cursor row still exists and belongs to the same session;
- the cursor row still participates in the normalized context order;
- the summary and cursor were committed together.

Increment `history_revision`, or delete the snapshot, when an operation:

- clears session messages;
- deletes or edits a message at or before the cursor;
- replaces imported history;
- rewrites message ordering or context eligibility.

Deleting a session must also delete its snapshot. Clearing history must not
leave an old summary available to future messages. This needs explicit coverage
because the current clear path does not invalidate the compression snapshot.

### Branched Sessions

Branch creation copies messages into new rows with new IDs, so the parent's
cursor cannot be copied unchanged.

While copying branch messages:

1. Preserve the source message ID alongside each copied message.
2. Record the mapping from source ID to child ID.
3. Translate the parent's `compressed_through_message_id` through that map.
4. Copy the summary only when the cursor is present in the copied prefix.
5. Otherwise start the child without a compression snapshot.

The existing index can remain useful as a migration fallback because a 1:1
branch copy preserves ordinal position, but the child snapshot must ultimately
store its own message cursor.

### Legacy Snapshot Migration

Existing snapshots have only `last_message_index`. Migrate them lazily when a
run first needs compression context:

1. Load the legacy normalized history using the current behavior.
2. Resolve `last_message_index` to the corresponding database message ID.
3. Validate that the resolved boundary does not split a tool interaction.
4. Persist the cursor and current history revision.
5. Continue through the new cursor path on later runs.

This permits one final full read per legacy snapshot while keeping all future
incremental loads bounded. If the legacy index cannot be resolved safely,
invalidate the snapshot and perform a normal first compression rather than
guessing a boundary.

Using SQL `OFFSET last_message_index` alone is not sufficient for the permanent
design. It avoids materializing old content but still depends on a shifting
ordinal and may not match the normalized context array when rows are filtered.

### Resume And Display Separation

Opening or reconnecting a session must not prepare the next model request.

The resume path should:

- load only the latest display page;
- query session and parent metadata without message bodies;
- return persisted usage values when available;
- defer snapshot-aware context construction until a run actually starts.

Starting a run should be the only path that assembles compression context. If
fresh context-token usage is needed before the next run, calculate it from the
summary, bounded head, and post-cursor range, preferably outside the latency
critical resume response.

## Data Access Boundaries

Introduce focused helpers instead of reusing full `getSessionDetail()`:

```ts
getSessionMetadata(sessionId)
getContextHead(sessionId, validLimit)
getContextAfterCursor(sessionId, cursorId, batchOptions?)
getContextHistoryForFirstCompression(sessionId)
resolveLegacyCompressionCursor(sessionId, lastMessageIndex)
```

Routes and Socket.IO handlers should not select message bodies when they need
only session metadata. Compression services should consume cursor-carrying
context entries rather than generic session-detail objects.

## Observability

Add structured timings around:

- display-page query and mapping;
- session metadata query;
- post-cursor context query;
- token estimation;
- first and incremental compression;
- legacy cursor migration.

Log the number of raw rows read, valid context messages produced, cursor ID,
snapshot revision, and elapsed time. Do not log message content or summary text.
Warn when a synchronous stage exceeds a defined threshold, initially one
second.

## Tests

### Snapshot And Cursor

- First compression stores the final summarized message ID.
- Incremental compression reads only protected head and post-cursor messages.
- A no-op incremental compression does not advance the cursor.
- Summary plus cursor produces the same effective context as the legacy full
  array implementation for representative histories.
- Filtered messages do not shift or corrupt the cursor.
- Tool calls and results are never split across the boundary.

### Mutation And Branching

- Appending messages preserves snapshot validity.
- Clearing history invalidates the snapshot in the same operation.
- Deleting a session removes its snapshot.
- Editing or removing a pre-cursor message invalidates the snapshot.
- Branch creation maps the parent cursor to the correct child message ID.
- A partial branch that excludes the parent cursor does not copy the snapshot.

### Legacy Migration

- A valid legacy index resolves once and persists a cursor.
- An invalid, stale, or turn-splitting legacy index is rejected safely.
- Later loads use the cursor path without another full-history query.

### Resume And Performance

- Socket resume emits only the configured latest page.
- Resume metadata does not call a full session-detail query.
- Resume does not build or tokenize complete DB history.
- A synthetic session with at least 15,000 mixed user, assistant, and tool rows
  remains responsive while opening and switching sessions.
- A large session with an existing snapshot reads a bounded head plus only the
  uncompressed range when starting a run.

## Implementation Slices

1. Add query instrumentation and focused metadata/context query helpers.
2. Remove full-history work from pure resume and reconnect paths.
3. Add cursor and history-revision fields while retaining legacy snapshot
   reads.
4. Carry database IDs through context normalization and update compressor
   results to return a cursor.
5. Switch incremental context construction to head plus post-cursor queries.
6. Add transactional invalidation for clear, delete, edit, and import paths.
7. Map snapshot cursors during branch creation.
8. Add lazy legacy migration, performance regression coverage, and operational
   timings.
9. Profile the completed path before deciding whether tokenization or SQLite
   work also needs a Worker Thread.

## Acceptance Criteria

- Opening, switching, or reconnecting to a session does not read or tokenize
  its complete message history.
- The first compression remains complete and accurate.
- After a snapshot exists, context construction does not load message bodies
  already represented by the summary.
- Incremental compression never loses, duplicates, or reorders a model-visible
  message.
- Tool interactions remain structurally valid across every compression
  boundary.
- Clear, delete, edit, import, and branch operations cannot reuse an invalid
  summary.
- Legacy snapshots migrate safely or are invalidated without guessing.
- Existing 150-message paging and live-chat rendering limits remain unchanged.
- Focused tests cover a history of at least 15,000 mixed-role rows.

## Open Questions

- Should `history_revision` live on `sessions` or only in the compression
  snapshot lifecycle?
- Should large post-cursor ranges stream from SQLite in batches or move to a
  Worker Thread after cursor adoption?
- Should per-message token counts be completed and aggregated so resume can
  show fresh usage without tokenizing text?
- Should message edits be supported as snapshot-invalidating operations, or
  remain unsupported for persisted chat history?
- Is a per-session monotonic context sequence preferable to mapping global
  message IDs during branch creation?
