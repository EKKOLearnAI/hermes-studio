---
date: 2026-08-16
feature: issue-2492-persist-collapsed-provider-groups
pr: 2585
impact: The Set Session Model dialog keeps the provider groups you collapsed instead of re-expanding all of them on every open. No change to model selection, switching, or MoA behaviour.
---

# Issue #2492

`ChatPanel` held the session-model dialog's collapse state in a local `sessionModelCollapsedGroups` ref and cleared it in `openSessionModelModal`, so someone with forty providers folded the same groups away again every single time they opened the dialog. Three other pickers — `ModelSelector`, `CombinationModelsPanel`, `WorkflowModelSelector` — had the identical ref-and-reset, each unaware of the others.

All four now read one shared record from `useCollapsedProviderGroups`, which stores it under `hermes.models.collapsedProviderGroups` through the existing `usePersistentRecord` composable. The record is created at module scope rather than per call, so two pickers open at once cannot write over each other's state; only collapsed groups are stored, so expanding a group removes its entry instead of accumulating `false` forever.

The chat surface change is confined to that dialog: `toggleSessionModelGroup` still refuses to act while a model switch is in flight, and nothing else in the run chain reads the collapse state.
