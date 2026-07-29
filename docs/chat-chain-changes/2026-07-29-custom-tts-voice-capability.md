---
date: 2026-07-29
pr: pending
feature: Custom TTS declares the voices capability
impact: The Voice field now renders for Custom TTS in both the Add dialog and the configurator, so an OpenAI-compatible provider that requires an explicit voice can be configured from the UI.
---

`tts-custom` now declares `capabilities.voices`, which is the flag both voice
surfaces already gate on: the Add TTS API dialog renders its free-text Voice
input, and `VoiceApiConfigurator` renders the voice field for the connection.
Without the flag, a Custom TTS connection had no way to set a voice, and the
request fell back to the provider default — which fails on providers whose
voice list does not include `alloy`.

Chat text, session persistence, and message ordering are unchanged.
