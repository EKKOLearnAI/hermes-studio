---
date: 2026-08-04
pr: 2346
feature: Group chat Profile TTS autoplay queue
impact: Group chat voice autoplay now waits for the active message to finish and synthesizes each Agent reply with that Agent's Profile TTS configuration.
---

Completed group replies bind their responding Agent's Profile to the autoplay
event before entering a FIFO queue. The next TTS request is not started until
the current audio ends or fails, so a newly completed reply cannot replace
audio that is already playing.

The Profile is sent explicitly to the existing authenticated TTS synthesis
endpoint while the provider is left for the server to resolve from that
Profile's active stored TTS configuration. Manual playback on a group Agent
message follows the same Profile-aware synthesis path. Single-chat playback and
the MCU realtime voice pipeline keep their existing entry points and behavior.
