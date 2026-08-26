# Background Callback Context Forks

Date: 2026-08-15
Status: Implemented in Studio for embedded Ekko and Hermes; standalone ekko-agent deferred

## Implementation Note

Studio now freezes callback context at the originating run instead of rebuilding
it from live session history. Embedded Ekko captures the complete tool-batch
boundary and carries that immutable fork in its internal completion event and
queue entry. Hermes captures the completed parent run's replayable messages and
keeps them in the process-local `SessionState`, keyed by delegation ID.

Both callback paths bypass live-history compression. Ekko also uses a fresh
ephemeral provider context with memory and skill review disabled. Hermes
snapshots are intentionally not persisted: if Studio restarts before delivery,
the recovered callback is rejected observably instead of falling back to newer
session history. The standalone `ekko-agent` repository is not changed by this
implementation.

## Decision Summary

An Ekko background task completion must continue from an immutable fork of the
parent context captured when `delegate_task` was accepted. It must not rebuild
its prompt from the session's latest database history when the child finishes.

The fork includes the conversation that led to the delegation and the complete
tool batch containing the accepted background delegation. The completion result
is appended to that fork as the callback's new input. User and assistant turns
created in the same session after that boundary remain on the live timeline but
are excluded from the callback model request.

This is specifically a later-history contamination bug. The earlier history is
already present today; the problem is that unrelated conversation created while
the child is running is also included.

## Problem

Ekko background delegation has two independent timelines:

1. The parent turn starts a detached child with `delegate_task` and can finish.
2. The user continues chatting in the parent session while the child runs.
3. When the child completes, Studio starts a hidden autonomous parent run to
   turn the child result into a user-facing response.

The completion run currently calls `buildCompressedHistory(sessionId, ...)` at
execution time. That query observes the live session at completion or dequeue
time, not the session state at delegation time. If several new turns have been
added, the callback receives them even though they did not exist when the
background task was started.

Example:

```text
T0  H0: existing conversation
T1  U1: asks for task A
T2  P1: calls delegate_task(A, background)
T3  P1: reports that A is running
T4  U2/A2, U3/A3: unrelated conversation continues
T5  child A completes

Current callback input:
  H0 + U1/P1 + U2/A2 + U3/A3 + child A result

Required callback input:
  fork(H0 + U1 + delegation boundary) + child A result
```

The current behavior can make the callback answer the newest topic, merge two
unrelated tasks, or treat later instructions as if they belonged to the older
background task.

## Terminology

- **Live timeline**: the persisted session history that continues to receive
  normal user and assistant messages.
- **Origin run**: the parent Ekko run that called `delegate_task`.
- **Delegation boundary**: the end of the complete tool batch that contains the
  accepted background `delegate_task` result. Capturing at the end of the batch
  keeps every assistant tool call paired with its tool result.
- **Origin fork**: an immutable, model-replayable message snapshot through the
  delegation boundary.
- **Callback run**: the hidden autonomous Ekko run scheduled after the child
  emits `subagent.complete`.
- **Intervening turns**: messages added to the live timeline after the origin
  fork was captured and before the callback starts.

## Required Semantics

The implementation must preserve these invariants:

1. Each accepted background delegation owns an independent origin fork.
2. The fork contains the context needed to understand the original request and
   a structurally valid assistant-tool/tool-result sequence through its
   delegation boundary.
3. The callback appends only the completed child's result as its new semantic
   input. It does not append intervening live messages.
4. Queue delay does not change callback context. A callback that waits behind
   another run uses the same origin fork it would have used immediately.
5. The live session is never rewound or replaced by the fork.
6. The callback's final assistant response is still appended to the live
   timeline at its actual delivery time.
7. Normal turns sent while the child runs continue to use the live history.
8. Two background tasks created at different boundaries cannot reuse each
   other's forks, even when they complete out of order.
9. Provider-native continuation state and long-term memory created after the
   boundary cannot reintroduce intervening context indirectly.
10. Control-plane state remains current. An explicit abort, deleted session,
    invalid workspace, or interrupted task may prevent delivery even though
    conversational messages after the boundary are excluded.

## Current Code Path

Ekko creates detached child tasks in
`packages/ekko-agent/src/runtime/runtime.ts`. The child publishes
`subagent.start`, progress events, and `subagent.complete` while retaining an
isolated child provider context.

`scheduleBackgroundContinuation()` in
`packages/server/src/modules/studio/services/chat-run/handle-ekko-agent-run.ts` converts
`subagent.complete` into a `QueuedRun`. The entry contains the hidden child
result prompt but no origin history or history boundary.

When that queued item runs, `handleEkkoAgentRun()` calls
`buildCompressedHistory()` and constructs:

```ts
instructionMessages + currentCompressedSessionHistory + callbackMessage
```

`buildCompressedHistory()` reads current database state. The queue transport in
`packages/server/src/modules/studio/services/chat-run/types.ts` and
`packages/server/src/modules/studio/sockets/chat-run.ts` also has no field for a
callback-owned context fork.

There is a second contamination path in the runtime. `AgentRuntime` caches
provider context by the session `contextKey`. Reusing the parent session key can
reuse provider state advanced by intervening turns even if the database message
list is corrected.

## Proposed Design

### 1. Capture a model-replayable origin fork

The origin fork should be captured inside the Ekko runtime, where the complete
assistant/tool sequence is known. Capture it at the end of the tool batch that
contains the accepted background delegation.

The replay snapshot contains:

- the normalized non-generated input messages supplied to the origin run;
- runtime-local assistant and tool messages produced through that tool batch;
- the origin run ID, model step, and subagent ID for correlation; and
- a schema version so later representation changes can fail safely.

The runtime-generated base system prompt should not be copied back as an
ordinary input system message. The callback rebuilds its system prompt from the
original queued run configuration and replays the conversational messages once.
This avoids nesting or duplicating Ekko's generated system prompt.

A provisional internal representation is:

```ts
interface EkkoBackgroundContinuationContext {
  version: 1
  subagentId: string
  originRunId: string
  originStep: number
  messages: AgentMessage[]
  memoryPolicy: 'disabled'
}
```

`messages` is internal model input, not display history. It must be deep-cloned
or otherwise made immutable before the origin run can append more messages.

Capturing only before the `delegate_task` call can leave an unmatched assistant
tool call. Capturing immediately after that individual result can still be
invalid when the assistant requested multiple tools in one batch. The complete
tool-batch boundary is therefore the minimum safe replay boundary.

### 2. Resolve the fast-child race before publishing completion

A very fast child can finish before the parent has appended every result in the
delegation tool batch. The background task record should therefore have a
context-readiness barrier:

```text
child starts
  -> child may finish
  -> parent completes delegation tool batch
  -> runtime freezes origin fork
  -> subagent.complete becomes deliverable with that fork
```

Progress events may continue immediately. Only terminal delivery needs to wait
for the origin fork. The runtime must not fall back to the latest database
history when the fork is unavailable; it should fail or suppress the callback
with an observable diagnostic instead of violating the isolation guarantee.

### 3. Carry the fork only through internal delivery state

Attach the fork to the internal completion event, then copy it into the
background continuation's `QueuedRun`. Thread the field unchanged through
`runQueuedItem()` into `handleEkkoAgentRun()`.

The field should be dedicated to Ekko background callbacks, for example:

```ts
interface QueuedRun {
  // existing fields
  ekkoBackgroundContinuationContext?: EkkoBackgroundContinuationContext
}
```

It must not be accepted from an untrusted socket/API request and must not be
included in `subagent.*`, `run.queued`, logs, telemetry payloads, or persisted
display messages. Existing public completion payloads should continue to expose
only task identity, status, summary, usage, and bounded output fields.

The first implementation can remain process-local because Ekko detached tasks
and the current run queue are already process-local. If background tasks become
durable later, the origin fork must become part of that durable task record;
reconstructing it at recovery time from then-current session history is not
valid.

### 4. Build callback input from the fork, not the live database

When `ekkoBackgroundContinuationContext` is present, the callback path must
bypass `buildCompressedHistory()` entirely and run with:

```text
original instructions/configuration
+ origin fork messages
+ hidden child completion result
```

The fork is already the compression result that the origin run actually used,
plus its runtime-local delegation prefix. The callback must not read, update,
or invalidate the live session compression snapshot on behalf of this older
fork.

Normal foreground runs and non-background queued messages keep the existing
database-backed compression path.

### 5. Isolate provider continuation state

The callback must use an ephemeral provider context key, such as:

```text
<session-id>:background-callback:<subagent-id>
```

It must not reuse the live session's `modelContexts` entry. The ephemeral entry
is deleted after callback success, failure, or abort. Sending the complete fork
with a fresh key prevents Responses-style provider state from silently adding
later turns that are absent from the explicit message list.

### 6. Prevent memory from bypassing the fork

The initial implementation should run background callbacks with automatic
memory retrieval and memory extraction disabled. Otherwise memory produced by
intervening live turns can enter the callback through a separate system-prompt
channel, and the callback can write branch-local conclusions back as if they
were learned from the current timeline.

If origin memory is required later, capture the exact memory payload or stable
memory IDs used by the origin run and replay only that origin version. Querying
the memory store again at completion time is not equivalent to a snapshot.

Automatic skill review should likewise avoid using the forked callback as a
signal to mutate session-global behavior unless it has explicit branch-aware
semantics.

## Queue And Timeline Behavior

If the child completes while the session is busy, its continuation remains in
the existing FIFO queue. The queue decides only when the callback runs; it does
not decide what history the callback receives.

The visible callback response is persisted at the bottom of the current live
timeline. This intentionally means that display order and model-input order are
different:

```text
Live display:    origin -> later chat -> callback response
Callback model: origin fork ---------> child result
```

Future normal turns may see the delivered callback response in chronological
database history. This proposal does not branch the visible session or create a
second user-visible conversation.

Later conversational text is not a cancellation channel. Current explicit
Stop/abort and session lifecycle checks remain authoritative control-plane
signals and must be evaluated before delivery.

## Compression And Size Constraints

The origin run has already passed through the host's compression and model
context checks. Reusing that effective input avoids a second read whose summary
may have advanced past the origin boundary.

The runtime-local delta can still add tool results. Snapshot sizing must:

- preserve assistant tool calls with all corresponding tool results;
- reuse existing sanitized/bounded tool content;
- enforce a callback context budget before the callback model request; and
- fail observably rather than dropping arbitrary messages or switching to live
  history.

Multiple background delegations can temporarily duplicate context in memory.
The implementation may share immutable prefixes internally, but every task
must retain a logically independent boundary.

## Alternatives Considered

### Read current session history at completion time

This is the current behavior and the source of the bug. Queue timing changes
semantic context, so identical background work can produce different callback
answers depending on how much the user chatted while waiting.

### Add only a database `throughId` cutoff

The session store can query through a message ID, but a cutoff alone is not a
complete solution:

- a newer compression snapshot may summarize messages beyond the cutoff;
- re-compressing an old prefix must not overwrite the live session snapshot;
- runtime-local assistant/tool messages may not yet have a stable database ID;
- hidden callback inputs are intentionally not ordinary persisted user turns;
  and
- provider-native context can still contain later turns.

A stable cursor can be useful metadata and a recovery aid, but it does not
replace an immutable effective-input fork.

### Capture history when the child completes

Completion is already too late. Any snapshot taken then contains the same
intervening conversation as the current implementation.

### Copy only the original user message

The callback can lose constraints, file references, decisions, and compressed
history that made the delegated goal meaningful. The required unit is the
origin model context, not one display message.

## Test Plan

### Runtime tests

- Capture a background delegation fork at a complete tool-batch boundary.
- Preserve every assistant tool call and matching tool result when delegation
  shares a batch with other tools.
- Buffer a terminal child event when the child finishes before context capture.
- Freeze separate snapshots for two delegations created at different steps.
- Verify later mutations to the parent `messages` array do not mutate a stored
  fork.
- Clean up ephemeral callback provider contexts on success, failure, and abort.

### Server tests

- Start background task A, finish the parent turn, add unrelated turns B and C,
  then complete A. Assert that the callback model request contains A's origin
  fork and result but no B/C content.
- Repeat with the callback queued behind an active run; queue delay must not
  change the request.
- Complete a task immediately while the parent is still executing and assert
  the same fork semantics.
- Complete two background tasks out of order and assert that each callback uses
  its own origin run and step.
- Create or advance a compression snapshot after delegation and assert that the
  callback neither consumes nor rewrites it.
- Seed the live provider context with intervening turns and assert that the
  callback uses a fresh context key.
- Add memory from an intervening turn and assert that it is absent from the
  callback and is not updated by callback completion.
- Assert that the internal fork is absent from public socket events, queue
  snapshots, stored messages, and logs.
- Preserve normal immediate callbacks where no intervening turns exist.
- Preserve interrupted-task behavior: interrupted children do not schedule a
  callback.

### Regression tests

- Normal Ekko turns continue using shared compression.
- Foreground delegation remains synchronous and unchanged.
- Background progress cards, usage accounting, workspace diffs, FIFO delivery,
  abort, and session resume behavior remain unchanged unless separately
  specified.

## Acceptance Criteria

The change is complete when an integration test can reproduce the T0-T5
timeline and inspect the actual callback model request to prove all of the
following:

- origin context is present;
- intervening user, assistant, reasoning, and tool content is absent;
- the child result is present exactly once;
- no later provider context or memory is attached;
- callback output is appended to the live timeline without rewinding it; and
- normal live conversation and multiple background callbacks remain usable.

## Out Of Scope

- Making Ekko background tasks or the run queue durable across server restarts.
- Persisting Hermes origin forks across Studio restarts.
- Updating the standalone `ekko-agent` repository.
- Introducing user-visible session branches.
- Redesigning background task cards or callback wording.
- Changing natural-language cancellation into a control-plane command.
- General background-task concurrency, session deletion, workspace-diff, or
  recovery policy beyond the isolation requirements above.
