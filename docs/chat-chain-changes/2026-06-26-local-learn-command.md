---
date: 2026-06-26
pr: pending
feature: Bridge /learn command
impact: Hermes chat sessions now expand `/learn` through Agent Bridge into the upstream skill-authoring prompt while displaying and storing the original slash command.
---

`/learn` runs as a normal bridge agent turn, queues behind active runs, supports bare `/learn`, and reports a clear unsupported-runtime message when `agent.learn_prompt` is missing.
