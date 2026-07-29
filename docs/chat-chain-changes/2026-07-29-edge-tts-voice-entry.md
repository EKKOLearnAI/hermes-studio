---
date: 2026-07-29
pr: pending
feature: Any Edge TTS voice can be selected or entered
impact: The Edge voice picker accepts a custom voice id and ships Arabic entries, so languages outside the previous eight-voice shortlist are reachable from the UI.
---

The Edge TTS voice picker was limited to a hardcoded shortlist of five Chinese
and three English voices, and the select was `filterable` without `tag`, so a
voice outside that list could not be entered at all. Edge serves hundreds of
voices across dozens of languages, and the value is passed through to the
synthesize request unchanged, so the restriction was UI-only.

The select is now taggable — the same behavior the Doubao voice select already
has — and the shortlist moved to `constants/edgeTtsVoices.ts` with Arabic
(`ar-SA-HamedNeural`, `ar-SA-ZariyahNeural`) added alongside the existing
entries. Stored voices are unaffected and no default changes.

Chat text, session persistence, and message ordering are unchanged.
