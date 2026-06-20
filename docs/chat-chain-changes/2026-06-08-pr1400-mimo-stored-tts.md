---
date: 2026-06-08
pr: 1400
feature: MiMo TTS playback with stored provider secrets
impact: Chat and group-chat message playback no longer require a local plaintext MiMo API key before calling the server TTS synthesize endpoint.
---

MiMo playback now sends the synthesize request even when the frontend key field is empty, allowing the server to merge the saved provider secret. If a user has typed a temporary key in the current session it is still sent with the request; otherwise the stored server-side key is used.
