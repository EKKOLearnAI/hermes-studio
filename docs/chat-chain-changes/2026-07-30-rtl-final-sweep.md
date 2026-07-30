---
date: 2026-07-30
pr: pending
feature: Every client component uses direction-aware CSS
impact: The last physical inline-axis declarations are gone from the chat side panels, file list, profile cards, usage breakdowns and workflow nodes, so a right-to-left locale is consistent across the whole UI. Left-to-right rendering is unchanged.
---

This completes the conversion started for the chat surface. The remaining 34
declarations across nineteen components — the chat side panels (browser,
terminal, files, folder picker, markdown renderer, outline, session search,
session rows, voice overlays, tool cards), the file list, profile cards, the
usage breakdowns and the workflow nodes — become their logical equivalents.

With no physical declaration left in any `.vue` file under
`packages/client/src`, `tests/client/rtl-logical-css.test.ts` no longer carries a
maintained list of converted components: it walks the whole client tree and fails
as soon as a physical inline-axis declaration is introduced anywhere.

Chat text, session persistence, and message ordering are unchanged.
