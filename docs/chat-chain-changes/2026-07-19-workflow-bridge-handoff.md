---
date: 2026-07-19
pr: 2137
feature: Workflow bridge handoff
impact: Hermes Workflow nodes no longer run ordinary-chat standing-goal evaluation after completion, while all Hermes bridge runs retain the existing broker readiness gate.
---

Workflow progression is owned by the DAG scheduler, and each Workflow node uses a
separate Session. Successful Workflow bridge runs now skip ordinary Chat's
standing-goal continuation judge while CLI and Global Agent sessions preserve the
existing continuation behavior.

Bridge reattachment also preserves `source: workflow` in both the socket state and
the resumed run helper, so a resumed Workflow node follows the same terminal
semantics as a fresh node.

Regression coverage forces source changes in both directions: Workflow completion
followed by queued CLI/Global Agent work still skips the judge, while CLI/Global
Agent completion followed by queued Workflow work still evaluates ordinary Chat
goals and keeps the completed run's source on any generated continuation. It also
covers empty-queue Workflow completion, synthetic completion when a bridge stream
ends without a terminal chunk, resumed runs, and caller-side source recovery from
a hydrated state that omits source. Workflow starts continue to use the same broker
readiness check as other Hermes bridge runs; this change does not bypass or extend
the existing outage behavior.
