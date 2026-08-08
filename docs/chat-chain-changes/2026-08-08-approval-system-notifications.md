---
date: 2026-08-08
pr: pending
feature: Approval and clarification system notifications
impact: Pending Direct Chat, Group Chat, and Workflow approvals can optionally produce one privacy-safe browser or desktop notification while Hermes Studio is in the background; clicks return to the exact in-app source without approving from the operating-system notification.
---

A new independent display setting requests browser notification permission before
it is persisted. It remains disabled by default and does not reuse completion
notifications or approval sounds. The setting includes a foreground-safe test
notification and preserves existing application-level pending cards.

The global pending host projects only newly surfaced authoritative pending keys.
Restored requests establish the baseline, repeated socket updates do not notify,
and a Web Lock plus a short shared ledger deduplicates delivery across multiple
Studio tabs. Notification text intentionally excludes commands, paths, and
clarification content.

Notification clicks carry only validated `/hermes/` targets through Web Service
Worker and Electron delivery paths. Direct and Group Chat targets identify their
Session or Room, while Workflow targets include workflow, run, node, and
execution identity and are resolved after the corresponding records load.
