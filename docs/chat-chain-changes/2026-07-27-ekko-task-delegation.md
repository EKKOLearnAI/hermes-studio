---
date: 2026-07-27
pr: 2236
feature: Ekko Agent task delegation
impact: Ekko can delegate isolated foreground tasks or launch visible background tasks that continue after the parent response and remain cancellable from the chat session.
---

The `delegate_task` tool accepts a self-contained goal, optional context, and a
`foreground` or `background` mode. Delegated runs inherit the parent model,
provider, workspace, and tools while using an isolated model context with
memory, recursive delegation, and automatic skill review disabled.

Foreground calls wait for the child result before the parent continues.
Background calls return a task ID immediately and publish the existing
`subagent.*` event stream as the child reasons, writes text, and uses tools.
Running and completed snapshots remain available through session resume, and
the normal chat abort action also stops detached Ekko background work.

Completed background results are delivered through a hidden autonomous parent
run. Delivery starts immediately when the session is idle or joins the normal
FIFO run queue when the parent is still busy; interrupted background tasks do
not schedule a continuation. Subagent events expose both `parent_run_id` and
`child_run_id`, and the terminal summary mirrors the accumulated streamed text
so the same child response is not emitted twice with different formatting.

Child model usage is attributed to the parent session, including tasks that
finish after the parent response. Ekko-owned task snapshots are excluded from
the Hermes Agent background poll because their lifecycle is managed in the
in-process Ekko runtime.
