---
date: 2026-09-05
pr: pending
feature: Bind calendar/reminder consent to authenticated originating device
impact: No broadcast to every App; foreign responses ignored and replay filtered. Unknown origin or offline target fails closed.
---

Identity comes from verified app_access token, not client-declared device ID.
Capture target when each direct run starts; reading/resuming a session does not
transfer ownership. Return a pseudonymous device_id for acceptance evidence.
Requires new originating mobile run after deployment. Web/unknown-origin runs
cannot silently choose a device. Location is unchanged in this scoped patch.
