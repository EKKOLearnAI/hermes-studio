---
date: 2026-08-02
pr: 2226
commit: pending
feature: Group Chat message-avatar participant quick settings
impact: Makes the sender avatar beside agent messages the direct, keyboard-accessible entry point for participant model, API mode, reasoning effort, and structured mention controls. The event carries the stable participant ID through GroupMessageItem and GroupMessageList to the existing Room-scoped save controller in GroupChatPanel; human messages stay non-interactive, exact sender IDs win over legacy assistant/tool name fallback, and current participant Session identity and next-run semantics are unchanged.
---

- Agent and legacy agent tool-message avatars render as semantic buttons with accessible names and `aria-expanded` state.
- Clicking or keyboard-activating a message avatar opens one shared quick-settings card next to the clicked avatar; Escape, outside click, message-list scrolling, and Room changes close it.
- The card reuses the existing serialized Room + participant quick-save queue and structured Mention insertion path instead of introducing a second persistence path.
- Human user messages never use the display-name compatibility fallback, preventing a person with the same display name from opening Agent runtime controls.
- Existing participant IDs, Runtime bindings, persisted Session IDs, message formats, handoff/outbox behavior, and config-only next-run application semantics remain unchanged.
