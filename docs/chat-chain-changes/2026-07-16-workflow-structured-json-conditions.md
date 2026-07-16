---
date: 2026-07-16
pr: 2099
feature: Structured JSON Workflow edge conditions
impact: Workflow edges can route on parsed assistant JSON fields through `outputJson.*`, while run history leads with the business outcome and the canvas replays the actual path with live and terminal edge states.
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

Run history now separates node transport outcomes from business results. It
keeps the outcome, blocker, root reason, and actual path visible before raw
scheduler details. Expanded path decisions show the field, operator, expected
value, actual value, and match result; missing condition evidence remains
unknown instead of being displayed as a mismatch.

The canvas derives edge playback from persisted run evidence. A taken edge is
animated while its target node is active, remains highlighted after completion,
and uses distinct blocked or failed colors when appropriate. Untaken edges are
de-emphasized, historical runs restore the same path after reload, and reduced
motion preferences disable the animation without hiding the selected path.
