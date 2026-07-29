---
date: 2026-07-29
pr: pending
feature: Hermes Studio voice provider bridge
impact: Chat, Group Chat, and realtime voice playback can use every server-managed Hermes Studio TTS provider without changing existing provider-specific paths.
---

The existing browser, OpenAI, custom, MiMo, and Doubao playback behavior
remains intact. Newly supported server-managed providers share the authenticated
TTS synthesis API, while Hermes Agent command providers call profile-scoped
loopback endpoints for TTS and STT.
