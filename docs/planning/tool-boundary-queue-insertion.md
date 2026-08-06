# Tool-Boundary Queue Insertion

Date: 2026-08-06
Status: Proposed

## Decision Summary

When a user sends a normal message while an agent turn is already running,
Studio should keep the message in the existing FIFO queue and stop the current
turn at the nearest safe boundary:

- If no tool batch is executing, interrupt the current turn immediately.
- If a tool batch is executing, let every tool call already issued by the
  current assistant response finish, then stop before the next model request.
- Start the queued message as a normal new `role: user` turn.

The feature must not send `/steer`, `/queue`, or any other Hermes command. It
must not append the queued text to a tool result, a system reminder, or the
currently active turn.

Hermes Agent and Ekko Agent can provide strict runtime-owned boundaries. Claude
Code can provide the same boundary on versions that support `PostToolBatch`.
The current Codex `exec --json` integration can initially provide only a
best-effort boundary; a strict Codex guarantee requires a blocking runtime
control point that the current protocol does not expose.

## Context

Studio already has a message queue. While a session is busy, a new user message
is added to `SessionState.queue`, the client receives `run.queued`, and the
message is started after the active run ends. The current queue does not ask the
active run to stop, so a long agentic run may perform many more model and tool
rounds before the queued message is processed.

The desired behavior is different from steering:

```text
current user turn
  -> model response
  -> current tool batch
  -> stop current turn
  -> queued user message starts a new turn
```

The queued text must remain a user message with its own turn identity. This
preserves role ordering, native Coding Agent session history, usage accounting,
and the user's ability to see exactly where the new request entered the
conversation.

## Terminology

- **Active turn**: the run currently owned by a Studio chat session.
- **Tool batch**: all tool calls emitted by one assistant/model response. A
  batch may execute sequentially or concurrently.
- **Tool boundary**: the point after that batch has resolved and before the
  runtime starts another model request.
- **Boundary stop**: a foreground-only stop requested for queue insertion.
- **Hard stop**: the existing explicit user abort, which may cancel an active
  tool and background work immediately.
- **Strict boundary**: the runtime itself makes the stop decision before its
  next model request.
- **Best-effort boundary**: Studio observes an external event and interrupts a
  child process; the child may already have started its next model request.

## Goals

- Reuse the current FIFO queue and queued-message UI.
- Stop immediately when no tool batch is executing.
- Never interrupt a tool call merely because a new message was queued.
- Never issue another model request after a strict runtime reaches the selected
  tool boundary.
- Submit the dequeued message through the normal run path as a new user turn.
- Support Hermes Agent, Ekko Agent, Claude Code, and Codex through one
  capability-based server contract.
- Keep explicit hard stop behavior available while a boundary stop is waiting.
- Preserve already-detached background delegations unless the user explicitly
  requests a hard stop.
- Make request, boundary, terminal, and dequeue ordering observable and
  testable.

## Non-Goals

- Do not implement this by calling Hermes `/steer` or `/queue`.
- Do not use Codex `turn/steer`; it changes the active turn rather than creating
  a new user turn.
- Do not inject queued text into tool results or model context.
- Do not persist every queue transition to the messages table.
- Do not make the in-memory queue durable across a server restart in the first
  implementation.
- Do not change explicit slash-command behavior while a run is active.
- Do not treat detached background agents as part of the foreground tool batch.
- Do not claim strict Codex behavior until the runtime exposes and Studio tests
  a synchronous pre-model boundary.

## Current Behavior

### Server Queue

`packages/server/src/services/hermes/run-chat/index.ts` enqueues a `QueuedRun`
when `state.isWorking` is true. `dequeueNextQueuedRun()` removes the head and
passes it back through `handleRun()`. The queued user message therefore already
has the correct normal-turn execution path.

Natural completion in Hermes Bridge and Ekko Agent handlers dequeues the next
run. `markAbortCompleted()` also dequeues after an explicit abort. The missing
piece is a safe request that ends the active turn at a tool boundary.

### Hermes Agent

The Python Agent Bridge receives synchronous `tool_start_callback` and
`tool_complete_callback` calls, but TypeScript reads those events by polling
Bridge output. A TypeScript listener cannot provide a strict boundary: Hermes
may return from the callback and begin its next model iteration before Studio
observes `tool.completed`.

Hermes does have a useful internal boundary. Its conversation loop invokes
`_execute_tool_calls(...)`, then continues to the next loop iteration. A
Bridge-owned post-tool-batch hook can set the foreground interrupt state after
`_execute_tool_calls(...)` returns and before the next provider request.

### Ekko Agent

`packages/ekko-agent/src/runtime/runtime.ts` owns the full loop:

```text
model request -> assistant tool calls -> execute tool calls -> next loop step
```

The runtime currently receives an external `AbortSignal`, but it has no
session-scoped method for requesting a graceful boundary stop. Because Studio
owns Ekko Agent, this method can be added directly without protocol inference.

### Claude Code

Studio launches Claude Code with `claude -p --output-format stream-json`.
Claude's current `PostToolBatch` hook runs after every tool call in the current
batch has resolved and before the next model request. Returning
`decision: "block"` or `continue: false` stops the agentic loop at that point.
The `--settings <file-or-json>` flag allows Studio to add a per-process hook
without modifying user or repository settings.

### Codex

Studio currently launches `codex exec --json` and observes `item.started` and
`item.completed` JSON lines. These lines are subprocess output, not a blocking
callback. Killing the process after the final observed tool item is useful, but
there is a race in which Codex may already have started the next model request.

Codex App Server exposes `item/completed` notifications and `turn/interrupt`,
but the public contract does not state that a client can atomically pause the
turn between an item completion and the next model request. Migrating transports
alone must therefore not be presented as a strict guarantee.

## User-Visible Semantics

Only normal user messages use automatic queue insertion. The first queued
message arms one boundary stop for the active run. Additional messages remain
FIFO and do not arm duplicate stops.

Recommended phases:

```text
queued
  -> waiting_for_tool_batch       tool batch is executing
  -> stopping_current_turn        boundary reached or no tool was active
  -> starting_queued_message      old run is terminal
  -> running
```

The queue UI should show a compact state such as “Waiting for current tools to
finish” or “Stopping current response.” It should not expose internal commands
or synthetic hook messages.

If the user presses the existing Stop button, hard stop supersedes the boundary
request and keeps its current immediate-cancellation semantics.

## Shared Server Design

### Session State

Add one run-scoped control object to `SessionState`:

```ts
type BoundaryGuarantee = 'strict' | 'best_effort'

interface QueueInsertionControl {
  generation: string
  runId?: string
  runMarker?: string
  queueId: string
  runtime: 'hermes' | 'ekko' | 'claude-code' | 'codex' | 'direct'
  guarantee: BoundaryGuarantee
  phase:
    | 'requesting'
    | 'waiting_for_tool_batch'
    | 'stopping_current_turn'
    | 'terminalizing'
  requestedAt: number
  boundaryReachedAt?: number
}
```

`generation` and the immutable run identity prevent a late tool completion,
hook callback, or child-process exit from stopping the next queued run.

### Runtime Contract

Expose a neutral adapter contract from the run owner:

```ts
type BoundaryInterruptResult =
  | {
      status: 'interrupted_now'
      guarantee: BoundaryGuarantee
    }
  | {
      status: 'waiting_for_tool_batch'
      guarantee: BoundaryGuarantee
      activeToolCount?: number
    }
  | {
      status: 'already_requested'
      guarantee: BoundaryGuarantee
    }
  | {
      status: 'unsupported'
      fallback: 'best_effort' | 'wait_for_natural_completion'
    }

requestBoundaryInterrupt(
  sessionId: string,
  expectedRunId?: string,
): Promise<BoundaryInterruptResult>
```

The method name describes the behavior, not the underlying runtime mechanism.
Hermes, Ekko, and Coding Agent managers implement it independently.

### Queue Trigger

When a normal message arrives during an active run:

1. Append the existing `QueuedRun` and emit `run.queued`.
2. If this is the first real queued user message for the active run, create
   `QueueInsertionControl`.
3. Call the active runtime's `requestBoundaryInterrupt(...)` once.
4. Emit the returned phase and guarantee.
5. Leave subsequent queued messages in FIFO order without another interrupt
   request.

Goal-continuation entries and background-delivery entries do not arm automatic
queue insertion. A real queued user message takes priority over an automatic
goal continuation.

### Terminalization And Dequeue

Boundary stop must not call the current hard-abort path wholesale. Hard abort
also interrupts background delegations, settles them as interrupted, and may
destroy a Bridge session. Queue insertion needs a foreground-only terminal
path.

Extract shared flush, usage, workspace-diff, state-reset, and dequeue behavior
into a terminalizer used by:

- natural completion;
- boundary completion;
- hard-abort completion where behavior is currently shared.

For a boundary stop, emit the existing terminal event with explicit metadata:

```ts
{
  event: 'run.completed',
  interrupted: true,
  stop_reason: 'queue_insertion',
  boundary_guarantee: 'strict' | 'best_effort',
  queue_remaining: number
}
```

The old run is not a failure. Any assistant text and completed tool results
that existed before the boundary remain in history. The terminalizer then
calls the existing `dequeueNextQueuedRun()`, which submits the queued content as
a normal new user turn.

### Socket Event

Keep `run.queued` as the authoritative queue-content event and add a small
state event:

```ts
run.queue_insertion.updated
```

Payload:

```ts
{
  event: 'run.queue_insertion.updated',
  session_id: string,
  run_id?: string,
  queue_id: string,
  phase:
    | 'waiting_for_tool_batch'
    | 'stopping_current_turn'
    | 'starting_queued_message'
    | 'cancelled',
  guarantee: 'strict' | 'best_effort'
}
```

This event is state, not a chat message, and must not be persisted into model
history.

## Runtime Adapters

### Hermes Agent: Strict Bridge Boundary

Add an Agent Bridge action such as:

```text
request_boundary_interrupt(session_id, expected_run_id)
```

The implementation belongs in the Python worker because it is the last Studio
layer that runs synchronously inside the Hermes turn.

Add run-scoped fields to `AgentSession` for:

- current Bridge run ID;
- foreground phase (`model`, `tool_batch`, or `idle`);
- pending boundary generation;
- whether the boundary has been crossed.

When creating the `AIAgent`, install one Bridge-owned post-tool-batch wrapper:

1. Mark the session as `tool_batch` before calling the original
   `_execute_tool_calls(...)`.
2. Let the original method finish the complete batch, including concurrent
   calls.
3. In `finally`, atomically inspect the pending boundary generation.
4. If pending, set a foreground-loop interrupt before returning to the Hermes
   conversation loop.
5. Emit a Bridge control event such as `run.boundary_reached`.

The wrapper must be installed once per agent instance and capability-checked
when Hermes is upgraded. It changes no Hermes files and sends no Hermes
instruction. A future public Hermes post-tool-batch callback should replace the
instance wrapper when available.

If the request arrives while the phase is not `tool_batch`, interrupt the
foreground provider call immediately. Do not use the existing broad
`AgentPool.interrupt()` behavior unchanged: that path also suppresses and
interrupts background delegations. Add a foreground-only helper that cancels
the active provider/tool-loop thread without propagating to detached child
agents.

The request and wrapper must use the same lock. If the batch finishes just
before the request acquires the lock, the request observes `model`/`idle` and
performs the immediate stop. If the request wins first, the wrapper consumes
the latch before the next model request. TypeScript `tool.completed` polling is
used only for display and persistence, never as the control signal.

### Ekko Agent: Strict Internal Method

Expose the method through Studio's internal Ekko layers:

```ts
AgentRuntime.requestBoundaryInterrupt(sessionId, expectedRunId?)
GlobalEkkoAgent.requestBoundaryInterrupt(sessionId, expectedRunId?)
```

`AgentRuntime` should own an active-run registry keyed by foreground session and
run ID. Each entry tracks:

- an internal abort controller linked to the host signal;
- current phase (`model` or `tool_batch`);
- the pending boundary generation;
- whether a boundary result has already been emitted.

The current `toolCalls` array is one batch. Even though Ekko executes its calls
sequentially today, a pending boundary is checked after the entire array is
resolved and before the next `for (step...)` iteration starts. This makes the
behavior stable if Ekko later adds parallel tool execution.

At the boundary, return a graceful run result with a dedicated finish reason
such as `queue_insertion`, and emit `run.completed` rather than treating the
stop as a model or tool failure. If the phase is `model`, abort the internal
provider request immediately and convert that known internal abort into the
same graceful boundary result.

Only the matching foreground run is affected. Detached Ekko subagents remain
running. A foreground `delegate_task` that is part of the current batch is
allowed to finish like any other foreground tool.

### Claude Code: Strict Hook Boundary

For supported Claude Code versions, add Studio-owned `PreToolUse` and
`PostToolBatch` command hooks through the per-process `--settings` argument. Do
not write `~/.claude/settings.json`, `.claude/settings.json`, or
`.claude/settings.local.json`.

The hook should invoke a Studio helper using an argument array. The helper
contacts a loopback or local-domain IPC endpoint with:

- an unguessable per-child capability token;
- Studio session and run identity;
- the hook's Claude native session ID.

`PreToolUse` announces the tool-call ID before Claude starts the tool.
`PostToolBatch` clears the active batch only after every call has resolved. The
server serializes those phase changes with queue insertion requests. This
avoids treating a running tool as idle merely because its stream-json
`tool_use` event has not reached Studio yet.

At `PostToolBatch`, the endpoint atomically checks the pending boundary
generation. It returns no decision when the run should continue. When a queued
insertion is pending, the helper prints a supported stop decision such as
`{"continue": false, "stopReason":
"studio_queue_insertion:<generation>"}`. Claude Code then ends the loop before
its next model call.

If a queue request wins the race just before `PreToolUse`, the run is already
in the immediate-stop phase. The `PreToolUse` helper must return a supported
stop/deny response so that the not-yet-started tool cannot slip through while
the child interrupt is being delivered. If `PreToolUse` wins first, the tool is
considered active and is allowed to finish before `PostToolBatch` stops the
loop.

Studio must recognize and suppress its own synthetic stop reason so it is not
stored or rendered as assistant content. Other user-configured hooks continue
to run under Claude's normal merge rules.

When the hook-owned phase reports that no tool batch is active, the Coding
Agent manager uses the existing child interrupt path immediately. The native
Claude session ID remains available, so the queued turn starts with the
existing `--resume` flow.

Feature detection is required. If the installed Claude Code does not support
the required hooks, a hook cannot contact Studio, or policy disables the hooks,
the adapter reports `best_effort` and falls back to observed `tool_use` /
`tool_result` events plus child interruption. The UI and logs must not call
that fallback strict.

### Codex: Best-Effort First, Strict Capability Later

For the current `codex exec --json` transport:

1. Track unfinished Codex tool items in `codexToolBlocks`.
2. If a boundary request arrives with no unfinished item, interrupt the child
   immediately.
3. Otherwise latch the request.
4. When the last observed tool item completes, send `SIGINT` once.
5. Preserve the Codex native thread ID and start the queued turn through the
   existing `codex exec resume` path.

This is best-effort because `item.completed` is read after Codex writes it to
stdout. Instrument the time between the item event and process interruption so
the race is measurable.

A later Codex implementation may migrate Studio to App Server for better
lifecycle control and use `turn/interrupt` instead of process signals.
`turn/steer` remains out of scope. The adapter can be promoted to `strict` only
after one of these is true:

- Codex exposes a blocking post-tool-batch hook;
- Codex exposes an atomic “interrupt before next model request” operation; or
- Studio owns tool dispatch and can hold the next model step itself.

App Server item notifications followed by `turn/interrupt` are not, by
themselves, proof of an atomic boundary.

### Direct Non-Agent Runs

For run sources that cannot execute local tools, there is no tool batch to
wait for. Abort their existing `AbortController` immediately and terminalize
the run as `queue_insertion`.

## Capability Matrix

| Runtime | Control point | Initial guarantee | Fallback |
| --- | --- | --- | --- |
| Hermes Agent | Python Bridge post-tool-batch wrapper | Strict | Disable automatic insertion if the runtime hook is incompatible |
| Ekko Agent | Internal runtime method before the next model step | Strict | None; fail the capability test in development |
| Claude Code | `PreToolUse` + `PostToolBatch` hooks from per-process settings | Strict when hook IPC is healthy | Observed stream events + child interrupt |
| Codex | Observed `item.completed` + child interrupt | Best effort | Wait for natural completion if process interruption is unsafe |
| Direct API response | Studio-owned abort signal, no tools | Strict immediate stop | Existing hard-stop mechanics |

## Race And Lifecycle Rules

### Request Versus Tool Completion

The runtime adapter, not Socket.IO display events, decides whether a tool batch
is active. The request and boundary check must be serialized by the runtime's
own lock or event loop.

### Parallel And Sequential Tools

All tool calls already issued in the current assistant response finish. The
runtime does not start another model request and does not execute tools from a
future assistant response.

### Tool Failure

A failed tool call still counts as resolved. Once every call in the batch is
completed or failed, the boundary is eligible.

### Approval And Clarification

A tool waiting for approval has not started executing. A queue insertion should
cancel the pending foreground approval/clarification and stop immediately.
Cleanup must prevent an orphaned promise or a late response from reaching the
next run.

### Queue Editing

If the user removes the only real queued message before the boundary is
crossed, disarm the boundary request. If another real queued message remains,
keep it armed. Once the runtime has crossed the boundary, removing the queue
head cannot resume the old turn; the next remaining item starts, or the session
becomes idle.

### Duplicate Requests

One boundary generation may be consumed once. Repeated socket submissions,
reconnect replay, duplicate hook calls, and duplicate tool completion events
must return `already_requested` or no-op.

### Stale Completion

Every callback checks the expected run ID and generation. A late callback from
the prior run must never stop the dequeued run.

### Hard Stop

Hard stop clears the boundary latch and follows the existing abort behavior,
including cancellation of active tools and background work. Late boundary
callbacks become no-ops.

### Background Delegation

Detached background tasks are not active foreground tools. They continue and
may deliver their results later. Queue insertion must not call the existing
background-suppression path. If the currently executing foreground tool is a
synchronous delegation, it finishes before the boundary.

### Server Restart

The first version inherits the current in-memory queue limitation. On restart,
Studio may reattach to the active runtime but cannot reconstruct unsaved queued
messages. Durable queues are a separate design.

## Persistence And Accounting

No database migration is required for the initial version.

- The queued message remains optimistic/in-memory until dequeued, matching the
  current queue.
- Completed tool calls and partial assistant text are flushed before the old
  run terminal event.
- The queued input is persisted once, when its normal run begins.
- Usage already reported by the old run is retained.
- No usage is fabricated for a cancelled provider request.
- Workspace diffs close against the old run before the queued run takes its
  checkpoint.
- Session `end_reason` should not be set to `complete` between the two runs.

If durable queue recovery is later added, persist queue items and boundary
generations in a dedicated table rather than as premature user messages.

## Security And Compatibility

- Construct Claude and Codex invocations with argument arrays.
- Keep helper tokens out of logs, chat events, and process listings where
  practical.
- Bind hook IPC to loopback or a user-private local socket.
- Reject mismatched native session IDs, Studio run IDs, and generations.
- Expire helper tokens when the child exits.
- Do not let a repository-provided hook forge a Studio boundary event.
- Preserve user and managed Claude settings; Studio's temporary hook must merge
  without weakening policy.
- Probe Hermes private-hook compatibility at worker startup and fail closed for
  automatic boundary insertion if the expected callable shape changes.

## Observability

Add structured logs and counters for:

- boundary requested by runtime and guarantee;
- immediate stop versus wait-for-tools;
- boundary reached;
- request-to-boundary latency;
- boundary-to-terminal latency;
- terminal-to-dequeue latency;
- duplicate or stale callbacks;
- Claude hook IPC unavailable or unsupported;
- Codex best-effort interruption delay;
- fallback to natural completion.

Do not log queued message text or hook capability tokens.

## Implementation Phases

### Phase 1: Shared Coordinator And Ekko Agent

- Add `QueueInsertionControl` and the runtime adapter contract.
- Extract safe boundary terminalization/dequeue behavior.
- Add Ekko's internal `requestBoundaryInterrupt()` implementation.
- Add socket state and client queue-state rendering.

This establishes the contract in a runtime Studio fully owns.

### Phase 2: Hermes Agent

- Add the Bridge request/action and run identity checks.
- Install the post-tool-batch wrapper and foreground-only interrupt.
- Add runtime compatibility probing.
- Verify detached background delegations continue.

### Phase 3: Claude Code

- Add temporary `PreToolUse` and `PostToolBatch` settings.
- Add authenticated local hook IPC and helper.
- Detect unsupported or disabled hooks.
- Suppress Studio's synthetic stop marker from chat history.

### Phase 4: Codex

- Ship the measured best-effort adapter behind an explicit capability label.
- Evaluate App Server migration separately.
- Promote to strict only when an atomic runtime boundary is available and
  covered by integration tests.

The feature may be enabled per runtime as each strict adapter lands. Codex can
remain opt-in or display its best-effort guarantee until the product decision
is made.

## Test Plan

### Shared Server Tests

- First queued user message arms exactly one boundary.
- Additional messages remain FIFO.
- Automatic goal-continuation entries do not arm the boundary.
- Boundary completion flushes old output before dequeuing.
- The dequeued item becomes one normal user message.
- Removing the final queued item disarms a pending boundary.
- Hard stop supersedes and clears the boundary.
- A stale run ID or generation cannot affect the next run.
- Workspace diff and usage belong to the correct run.

### Hermes Bridge Tests

- Request during a sequential tool batch finishes the complete batch and makes
  no next model request.
- Request during a parallel batch waits for every active call.
- Request immediately before/after batch completion is race-safe.
- Request during model streaming interrupts immediately.
- Tool failure still reaches the boundary.
- Approval and clarification waits are cleaned up.
- Background delegations are not interrupted.
- Duplicate and stale Bridge actions are no-ops.
- Runtime upgrade/callable mismatch disables the feature clearly.

### Ekko Agent Tests

- `requestBoundaryInterrupt()` during the model phase aborts the provider call.
- The method during a tool batch allows all current calls to finish.
- No model request occurs after the boundary.
- The run returns a graceful `queue_insertion` finish reason.
- Foreground session/run matching prevents cross-session interruption.
- Background subagents continue.
- External hard abort retains its stronger behavior.

### Claude Code Tests

- Temporary settings do not modify user or project files.
- `PreToolUse` marks a tool active before execution begins.
- A queue request immediately before `PreToolUse` prevents that tool from
  starting.
- A queue request immediately after `PreToolUse` waits for the batch.
- The helper allows the loop when no boundary is pending.
- The helper stops at `PostToolBatch` when the generation is armed.
- Parallel tool batches finish before stop.
- The synthetic stop reason is neither displayed nor persisted.
- User-defined hooks still run.
- Invalid token/session/run identity is rejected.
- Child exit expires the capability.
- Unsupported hook versions use and report the configured fallback.

### Codex Tests

- No active tool causes immediate child interruption.
- The last observed active item triggers one interruption.
- Multiple or out-of-order item events do not duplicate terminalization.
- Native thread ID survives and the queued turn resumes normally.
- Interruption delay is measured.
- Tests and UI never label the adapter strict.

### Client And End-To-End Tests

- Queue state changes render without adding chat messages.
- Reconnect restores the server's current insertion phase.
- Cancelling queued messages updates the boundary state.
- A boundary-stopped turn followed by a queued turn has correct message order.
- Existing explicit Stop and natural queue completion remain unchanged.

Chat-chain implementation must include the required
`docs/chat-chain-changes/*.md` record and run the validation set specified in
`docs/harness/validation.md`.

## Acceptance Criteria

- On Hermes, Ekko, and supported Claude Code, a queued message submitted during
  a tool batch causes zero subsequent model requests in the old turn.
- No active tool is cancelled by automatic queue insertion.
- When no tool is active, the old turn begins stopping immediately.
- The queued text appears exactly once as the next normal user message.
- No slash command, steer marker, tool-result injection, or synthetic hook
  warning enters model-visible history.
- Detached background work is preserved.
- Codex behavior is visibly and programmatically marked best effort until a
  strict control point exists.

## Expected Change Surface

Likely implementation touchpoints:

- `packages/server/src/services/hermes/run-chat/index.ts`
- `packages/server/src/services/hermes/run-chat/types.ts`
- `packages/server/src/services/hermes/run-chat/abort.ts`
- `packages/server/src/services/hermes/run-chat/handle-bridge-run.ts`
- `packages/server/src/services/hermes/run-chat/handle-ekko-agent-run.ts`
- `packages/server/src/services/hermes/agent-bridge/client.ts`
- `packages/server/src/services/hermes/agent-bridge/python/bridge_server.py`
- `packages/server/src/services/hermes/agent-bridge/python/bridge_broker.py`
- `packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py`
- `packages/ekko-agent/src/runtime/runtime.ts`
- `packages/server/src/services/ekko-agent/manager.ts`
- `packages/server/src/services/agent-runner/coding-agent-run-manager.ts`
- `packages/client/src/stores/hermes/chat.ts`
- queue-related client components and every locale file
- server, Ekko runtime, Bridge Python, client, and end-to-end tests

## References

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Claude Code settings precedence](https://code.claude.com/docs/en/settings)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
