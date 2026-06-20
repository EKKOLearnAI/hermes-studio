---
date: 2026-06-17
pr: pending
feature: Group chat add agent room validation
impact: Adding an agent in group chat without selecting a room now shows a warning message instead of silently failing.
---

The `confirmAddAgent` function in `GroupChatPanel.vue` previously returned silently when `store.currentRoomId` was missing, causing no feedback when the user clicked "Add" without having joined a room. The guard is now split so the room check triggers a `message.warning` with proper i18n text before proceeding. No backend or chat session data changes.
