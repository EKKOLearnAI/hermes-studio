---
date: 2026-07-13
pr: 2066
feature: Mobile realtime voice transcription
impact: Mobile realtime voice now uses explicit tap-to-start and tap-to-stop backend transcription while desktop browser speech recognition keeps its existing automatic listening behavior.
---

Phones, including browsers using desktop-site mode, no longer depend on browser speech recognition to detect speech boundaries. When a backend STT provider is configured, each mobile voice turn starts only after the user taps the voice control and is transcribed after they tap again to stop. Desktop capture and its backend fallback behavior are unchanged.
