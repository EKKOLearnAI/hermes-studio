---
date: 2026-06-30
commit: 9d526dad
feature: Chat / New Chat drawer
impact: label-only drawer confirmation copy change; no chat-chain persistence or runtime behavior impact
---

# New Chat drawer confirmation label

Changed file: `packages/client/src/components/hermes/chat/ChatPanel.vue`

The left-sidebar trigger remains labeled as the entry action (`chat.newChat`). The drawer submit button now uses the existing create confirmation label (`common.create`) so the trigger and final confirmation action are not both rendered as “New Chat”.

No chat-chain persistence, message ordering, fork/session identity, or runtime transport behavior changes.
