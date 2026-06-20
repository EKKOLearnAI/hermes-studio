---
date: 2026-06-16
pr: 1612
feature: Local chat session fork command
impact: `/fork` is a local chat session command for idle sessions; it copies the current transcript and compression snapshot into a linked child session, preserves session source, switches the client to the child, and shows parent lineage with the previous last visible message.
---

Validation: full test suite, production build, browser UAT for `/fo` command suggestion and fork lineage rendering.
