---
date: 2026-08-18
feature: issue-2513-reasoning-effort-drag-hint
pr: 2605
impact: The reasoning effort popover gains one line of muted helper text under the slider. No change to how effort is chosen, stored or sent with a run.
---

# Issue #2513

The reasoning effort control is an eight-stop slider, but the popover prints only the two end labels — "Default (config.yaml)" on the left and "Max" on the right. Read quickly that looks like two fixed choices rather than a range, and the reporter says they nearly concluded the setting was incomplete.

A line under the slider now names the number of stops and says it can be dragged, taking the count from `reasoningEffortOptions` so it cannot drift from the real number of levels. The string is added to all eleven locales.

Nothing else changes: the slider's value, its `@update:value` handler, and everything downstream of the chosen effort are untouched.
