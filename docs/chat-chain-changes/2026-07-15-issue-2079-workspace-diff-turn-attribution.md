---
date: 2026-07-15
issue: "#2079"
pr: "#2082"
feature: Attach Workspace Diff summaries to the Assistant response that produced them
impact: Coding Agent checkpoints and native Hermes Agent runs now persist the final Assistant message ID and render as collapsed per-turn summaries inside that response, including workspace changes made through ordinary terminal and write_file tools; legacy or not-yet-loaded records keep the existing standalone fallback without deleting audit history.
---
