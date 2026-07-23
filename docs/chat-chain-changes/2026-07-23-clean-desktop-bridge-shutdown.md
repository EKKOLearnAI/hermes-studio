---
date: 2026-07-23
pr: pending
feature: Clean Desktop Agent Bridge shutdown
impact: Exiting Hermes Studio now force-stops the managed Agent Bridge process tree if graceful shutdown does not finish in time.
---

Desktop shutdown still asks the Agent Bridge and its profile workers to stop
gracefully first. If that path stalls, Windows terminates the complete process
tree and Linux/macOS terminate the detached bridge process group so worker and
MCP subprocesses do not remain after the app exits.

The Desktop browser broker also has a bounded shutdown path, ensuring an active
browser operation cannot prevent Web UI and Agent Bridge cleanup from running.
The Web UI shutdown deadline repeats the bridge force-stop before its final
process exit as a last-resort safeguard.
