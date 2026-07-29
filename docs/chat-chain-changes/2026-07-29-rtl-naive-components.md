---
date: 2026-07-29
pr: pending
feature: Naive UI components mirror for right-to-left locales
impact: Inputs, selects, cards, drawers, dialogs, tables and other Naive UI components render mirrored when an RTL locale is active, instead of keeping left-to-right internals inside an RTL document.
---

Naive UI only mirrors the components handed to `NConfigProvider`'s `rtl` prop.
`constants/naiveRtl.ts` collects the RTL style module of every component the app
uses and `App.vue` passes that list while an RTL locale is active, or `undefined`
otherwise so left-to-right rendering is byte-identical to before.

The style modules are not re-exported from the package root, so each is imported
from its own styles entry. Two upstream quirks are handled: `heatmap` does not
re-export its RTL module from its styles entry, and `treeSelectRtl` is registered
under the same `Select` name as `selectRtl` with `treeRtl` as its only extra peer.

Chat text, session persistence, and message ordering are unchanged.
