---
date: 2026-07-13
pr: 11
feature: Workflow lifecycle recovery and timeout drain
impact: Workflow runAndWait timeouts now abort the underlying runner; server restart recovery terminalizes orphaned workflow runs before WorkflowSocket becomes available.
---

# Workflow lifecycle recovery and timeout drain

- `runAndWait` preserves its existing timeout error contract while also invoking `abortSession` for the timed-out session.
- Startup registers and initializes ChatRun first, then fail-closes active workflow runs and aborts surviving runners, then initializes WorkflowSocket.
- Active workflow node sessions and active loop iteration paths are terminalized before runner abort.
- Workflow deletion uses an internal unbounded run query rather than the public 500-run page.
- Terminal Run/Node Session states reject late conflicting updates, and terminal Runs reject late Edge/Loop evidence.
