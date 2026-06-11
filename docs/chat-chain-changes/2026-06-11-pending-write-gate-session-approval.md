---
date: 2026-06-11
pr: pending
feature: Write gate session approval
impact: Web UI bridge memory approvals now honor the visible "allow this session" choice for repeated memory write prompts in the same chat session.
---

The bridge records session-level approval only for Hermes Agent memory write
approval prompts (`Save to memory:` with no permanent option). Other approval
types continue to use their existing once/session/always behavior.
