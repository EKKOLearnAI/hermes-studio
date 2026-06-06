---
date: 2026-06-06
pr: 1351
feature: Bridge execute_code approval memory
impact: Web UI Bridge keeps HERMES_EXEC_ASK enabled while honoring session/always choices for execute_code approvals.
---

`hermes_bridge.py` now records gateway approval pattern keys and installs a bridge-local wrapper around `tools.approval.check_execute_code_guard()` so `execute_code` approvals can use the upstream session/permanent allowlist APIs without patching the Hermes Agent runtime.
