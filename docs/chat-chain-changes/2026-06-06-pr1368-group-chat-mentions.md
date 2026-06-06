---
date: 2026-06-06
pr: 1368
feature: Group Chat mention input
impact: Group Chat mention suggestions continue updating after users manually resize the message input.
---

`GroupChatInput` now updates typing and mention state before skipping textarea
auto-height changes for a custom resized input, so later `@` mentions still
open the agent picker.
