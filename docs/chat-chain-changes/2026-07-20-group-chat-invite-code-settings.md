---
date: 2026-07-20
pr: pending
feature: Group chat invite code settings
impact: Room managers can rotate a group room invite code from the Web UI settings modal, immediately updating local room state after the manager-authorized API call succeeds.
---

Adds the room-settings UI path for an existing manager-authorized invite-code rotation endpoint; old invite codes are invalidated by the server.
The update controls stay locked while a rotation is in flight, and readonly rooms keep invite codes redacted in UI coverage.
