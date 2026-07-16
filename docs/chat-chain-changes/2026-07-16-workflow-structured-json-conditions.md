---
date: 2026-07-16
pr: pending
feature: Structured JSON Workflow edge conditions
impact: Workflow edges can route on parsed assistant JSON fields through `outputJson.*`, independent of JSON whitespace, while malformed or ambiguous structured output fails closed.
---

# Structured JSON Workflow edge conditions

Workflow success conditions can now inspect `outputJson` while preserving the
existing raw `output` string contract. The runtime accepts either a complete JSON
assistant reply or exactly one fenced `json` block. Missing, malformed, or
multiple JSON blocks leave `outputJson` unavailable, so structured paths do not
match.

The same parsed condition context is used by completion-driven DAG runs,
recursive feedback loops, and reruns. Existing text conditions remain unchanged.
The edge editor exposes the structured path explicitly, explains the parsing
boundary, and preserves paths such as `outputJson.route_token` across save and
reopen.
