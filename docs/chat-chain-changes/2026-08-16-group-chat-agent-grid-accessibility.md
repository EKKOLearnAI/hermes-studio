---
date: 2026-08-16
feature: issue-2552-group-chat-agent-grid-accessibility
impact: The fixed Room Agent grid now exposes the complete persisted roster and the separate running roster through localized tooltip and accessible-name text.
pr: 2573
---

# Issue #2552 accessibility follow-up

The local Room Agent grid now describes the complete persisted Agent roster,
including Agents hidden behind the overflow cell, and separately identifies
which roster members are running. Idle Rooms explicitly report that no Agent is
running, while empty Rooms use a deterministic neutral description. The same
localized summary is used for the grid tooltip and accessible name; layout,
animation, run lifecycle, permissions, and remote Room behavior are unchanged.
