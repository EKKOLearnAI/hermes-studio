---
date: 2026-06-16
pr: 1612
feature: Local chat session fork command
impact: `/fork` and `/branch` are local chat session commands for idle sessions; they copy the current transcript into a linked child session, preserve session source, switch the client to the child, and show parent lineage with the previous last visible message.
---

Validation: full test suite, production build, browser UAT for `/fo` command suggestion and fork lineage rendering.
