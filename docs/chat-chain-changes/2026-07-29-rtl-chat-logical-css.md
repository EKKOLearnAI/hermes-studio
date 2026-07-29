---
date: 2026-07-29
pr: pending
feature: Chat surface spacing, borders and text alignment follow the writing direction
impact: Chat bubbles, message meta rows, the composer and the panel chrome keep their spacing on the correct side under a right-to-left locale; left-to-right rendering is unchanged.
---

The chat surface used physical `margin-left`/`margin-right`,
`padding-left`/`padding-right`, `border-left`/`border-right` and
`text-align: left`, which stay pinned to a physical side and therefore break
under `dir="rtl"`: indentation appears on the wrong edge, quote and thinking
borders land on the opposite side of the block they belong to, and inline labels
drift away from the text they annotate.

Those 32 declarations across `ChatInput.vue`, `ChatPanel.vue`, `MessageItem.vue`
and `MessageList.vue` are now the logical equivalents
(`margin-inline-start`/`-end`, `padding-inline-start`/`-end`,
`border-inline-start`/`-end`, `text-align: start`). Logical properties resolve to
the previous physical sides for left-to-right locales, so nothing changes there.

`tests/client/rtl-logical-css.test.ts` fails if a physical inline-axis
declaration is reintroduced into these components.

Absolutely positioned offsets (`left`/`right`) in the same components are left for
a follow-up change; symmetric pairs such as `left: 8px; right: 8px` are
direction-agnostic and stay as they are.

Chat text, session persistence, and message ordering are unchanged.
