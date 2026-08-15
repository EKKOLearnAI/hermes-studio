---
date: 2026-08-16
pr: pending
feature: Group Chat interaction runtime fallback
impact: Pending approval and clarification responses now continue to the owning Runtime when a same-name remote responder reports that it did not handle the request.
---

A successful remote response still resolves the pending route immediately. Expired or failed remote responses keep their existing terminal error handling and are not delivered twice.
