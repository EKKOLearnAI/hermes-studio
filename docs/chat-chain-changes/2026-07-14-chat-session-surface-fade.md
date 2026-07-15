---
date: 2026-07-14
pr: 2069
feature: Chat session surface fade
impact: Switching sessions replays the fade across both the conversation and input without remounting either component.
---

The persistent chat surface now replays its existing fade animation when the
active session changes. The input component stays mounted so drafts, focus, and
other local input state are preserved during the transition.
