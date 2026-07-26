---
date: 2026-07-26
pr: pending
feature: Session-scoped YOLO chat command
impact: Hermes chat sessions can toggle dangerous-command approval bypass with `/yolo`, including when it is the first message before an Agent session exists.
---

The Web UI handles `/yolo` as an immediate local chat command and forwards the toggle to the Agent Bridge under the current Web UI session ID. It never enters the model queue, remains isolated from other sessions, and can be toggled while a run is active.
