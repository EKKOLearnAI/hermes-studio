---
date: 2026-06-10
pr: 1477
feature: Completion notifications
impact: Chat run completion now optionally triggers browser or desktop system notifications after the existing completion bell without changing run protocol, message persistence, resume, or queue behavior.
---

- The notification is emitted from the existing `run.completed` handling after the assistant message is finalized.
- The notification title uses the session title, the icon follows the active agent type, and the body is a truncated preview of the completed assistant message.
