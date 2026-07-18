---
date: 2026-07-18
issue: "#2111"
pr: 2128
feature: Workflow route and history legibility
impact: Workflow connection authoring, loop routes, and read-only run history explain persisted path decisions without changing scheduler semantics.
---

Workflow connections use one condition-edge renderer for normal edges and self-loops, with labels that describe the saved route and optional condition. The editor recognizes feedback cycles from graph structure, validates loop scopes before save, and keeps visual playback metadata out of the persisted definition.

Run history projects persisted node, edge, condition, and loop evidence into operator-readable paths. It separates technical execution success from parsed business outcomes, shows expected and actual condition values, and keeps historical canvas playback read-only.
