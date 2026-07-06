---
date: 2026-07-06
commit: pending
feature: Chat input height display setting
impact: Chat and Group Chat input boxes now apply display setting changes after a local drag resize without changing run protocol, message persistence, resume, queue, or agent execution semantics.
---

Changing `display.chat_input_height` clears the current input component's local manual-resize override and reapplies the configured desktop height. The input frame derives its minimum height from the configured textarea height, so the visible border changes together with the text area. Mobile auto-height behavior remains unchanged.
