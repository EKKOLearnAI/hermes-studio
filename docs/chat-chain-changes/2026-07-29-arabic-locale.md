---
date: 2026-07-29
pr: pending
feature: Arabic (ar) locale
impact: The Web UI can be used in Arabic; the language switcher offers العربية and every translation key resolves from the Arabic locale.
---

Adds `packages/client/src/i18n/locales/ar.ts`, a complete Arabic translation of
the English locale with the same key tree, and registers it in the three places
a locale has to appear: `supportedLocales`, the lazy `localeLoaders` map, and the
`LanguageSwitch` options list. `tests/client/i18n-coverage.test.ts` now includes
the locale so the existing parity, changelog-compilation, per-section
localization and compact-label assertions cover Arabic too.

Terminology is kept consistent across sections (بروفايل, مهارة, البوابة, نموذج,
مزوّد, مسار العمل, كانبان), while product names, model ids, environment variable
names, CLI commands, file paths and keyboard shortcuts stay untranslated.

Right-to-left layout is intentionally not part of this change: the locale is
useful on its own, and `dir="rtl"` plus the layout work it implies is a separate
change with a much wider surface.

Chat text, session persistence, and message ordering are unchanged.
