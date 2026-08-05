---
date: 2026-08-05
pr: 2359
feature: Final structured mention and activity-time repair
impact: Same-name mention tokens retain independent stable identities; agent handoffs emit validated structured IDs; live room ordering uses server persistence time.
---

Mention metadata now tracks each visible token range independently and is removed
when that exact token is edited away. Agent replies derive structured targets only
from unique, current room participants, while socket clients use `persistedAt`
instead of sender-supplied display timestamps for live activity ordering.
