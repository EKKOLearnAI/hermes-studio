---
date: 2026-07-30
pr: pending
feature: Group chat spacing, borders and alignment follow the writing direction
impact: Group chat rooms, message rows and the composer keep their spacing on the correct side under a right-to-left locale; left-to-right rendering is unchanged.
---

`GroupChatPanel.vue`, `GroupMessageItem.vue` and `GroupChatInput.vue` pinned
spacing and borders to physical sides, so under `dir="rtl"` the member column,
mention chips, quoted blocks and composer gutters stayed on the wrong edge.

16 declarations become their logical equivalents (`margin-inline-start`/`-end`,
`padding-inline-start`/`-end`, `border-inline-start`/`-end`,
`text-align: start`). Logical properties resolve to the previous physical sides
for left-to-right locales, so nothing changes there.

`tests/client/rtl-logical-css.test.ts` now covers these components too.

Chat text, session persistence, and message ordering are unchanged.
