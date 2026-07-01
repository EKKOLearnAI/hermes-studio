---
date: 2026-07-01
pr: 1883
commit: ac08e857
feature: Chat input toolbar refresh
impact: Chat and group chat composers keep the existing send, stop, attachment, reasoning, settings, model switching, and tool trace behavior while moving controls into the input surface and aligning first-paint fade/background treatment.
---

The chat input surface now owns the toolbar layout, settings dropdown, compact model switcher trigger, and context usage overlay. Message-list fade-in moved to the surrounding chat surface so the composer and transcript share the same initial background transition.
