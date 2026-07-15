---
date: 2026-07-03
pr: pending
feature: Bridge execute_code approval memory
impact: Agent Bridge execute_code approvals remain compatible with Hermes Agent 0.18.0's has_host_access guard parameter.
---

The bridge-local wrapper around `tools.approval.check_execute_code_guard()` now
forwards extra positional and keyword arguments to the upstream guard. This keeps
the Web UI session/always approval memory layer working when Hermes Agent adds
new execute_code guard parameters such as `has_host_access`.
