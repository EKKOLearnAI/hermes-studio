---
date: 2026-07-16
pr: 2099
feature: Structured JSON Workflow edge conditions
impact: Workflow edges can route on parsed assistant JSON fields through `outputJson.*`, while run history leads with the business outcome, the canvas replays the actual path, and connection authoring uses four-sided handles with automatic loop recognition.
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

## Connection authoring

Each workflow node now exposes one connection handle on its left, top, right,
and bottom edge. A handle can start or receive a connection, while existing
`input` and `output` handle identifiers continue to map to the left and right
sides without requiring workflow migration.

Clicking a connection starts a short visual preview. Double-clicking or using
the context menu opens the connection editor. The editor leads with the source
and target node names, then explains the relationship as the source result,
an optional content check, and the next node to run. Runtime values such as
`success`, `contains`, and typed condition values remain unchanged in the saved
definition.

A connection that closes a cycle is recognized as feedback automatically. A
same-node connection can be drawn between two different sides and is rendered
with a dedicated orthogonal path outside the node card. The path uses the node's
measured Vue Flow bounds rather than fixed size assumptions, so every directed
pair among the four handles routes around wide and tall cards. The editor
describes the return node and loop scope; the raw loop identifier is an optional
advanced history label rather than the source of loop structure.

Before save, the client applies the same loop constraints as runtime preflight:
the return target must reach and dominate the latch, custom history labels must
be unique, and multiple loops must be separate or fully nested. Equal loop
scopes and partially overlapping loops are rejected with localized guidance.
Animation, playback classes, and preview markers remain visual projections and
are never serialized into the workflow definition.
