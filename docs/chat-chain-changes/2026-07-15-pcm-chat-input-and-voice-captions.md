---
date: 2026-07-15
pr: 2086
feature: PCM chat input and voice caption lifecycle
impact: Mobile and Electron chat input recordings now upload PCM/WAV, and realtime voice no longer restores the user's transcript after assistant TTS begins.
---

Backend STT capture from the chat input now uses the same single-shot 16 kHz PCM/WAV recorder as the STT settings test on mobile devices and in the Electron desktop shell. Regular browser sessions keep their existing browser recognition and MediaRecorder behavior.

Realtime voice keeps the submitted transcript visible while waiting for the first assistant audio segment. Once TTS starts, gaps between assistant speech segments show the thinking hint instead of falling back to the user's previous transcript.
