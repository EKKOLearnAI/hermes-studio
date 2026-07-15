---
date: 2026-07-03
commit: 0a3a7b4f
feature: Chat input resize
impact: Single-chat input manual height dragging again controls the visible textarea height after the refreshed toolbar layout; chat session creation, message ordering, and runtime transport behavior are unchanged.
---

# Chat input resize

Changed file: `packages/client/src/components/hermes/chat/ChatInput.vue`

The single-chat input textarea no longer flexes to fill the vertical input wrapper, so the existing resize handle's manual height value is reflected in the visible text area. The bottom toolbar stays pinned to the lower edge of the input wrapper.
