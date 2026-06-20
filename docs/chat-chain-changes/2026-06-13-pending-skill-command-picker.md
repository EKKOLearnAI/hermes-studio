---
date: 2026-06-13
pr: pending
feature: Skill slash command picker
impact: Chat can select enabled profile skills from a /skill picker modal and send expanded skill invocation prompts while preserving the visible /skill command in history and queue state.
---

The chat input now opens a skill picker modal from `/skill`, loads skills for the active session profile, and inserts `/skill <skill-name>`. The server translates that visible command into Hermes Agent's skill command dispatch while preserving the visible `/skill` command text for UI history.
