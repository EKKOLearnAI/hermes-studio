---
date: 2026-07-29
pr: pending
feature: Document writing direction follows the active locale
impact: Selecting a right-to-left locale mirrors the document, so native bidi layout and text alignment apply instead of forcing left-to-right.
---

`<html dir>` is now derived from the active locale alongside `<html lang>`, both
at startup and on every `switchLocale` call. Direction resolution lives in
`i18n/direction.ts` and works on the primary subtag, so regional tags such as
`ar-SA` resolve correctly.

Left-to-right locales are unaffected: they receive `dir="ltr"`, which was the
implicit behavior before this change.

Component-level mirroring for Naive UI (its `NConfigProvider` `rtl` prop and the
per-component RTL style modules) and any layout rules that still assume physical
left/right are intentionally out of scope here.

Chat text, session persistence, and message ordering are unchanged.
