---
date: 2026-08-04
pr: 2346
feature: Group chat Profile TTS autoplay queue
impact: Group chat voice autoplay now waits for the active message to finish and synthesizes each Agent reply with that Agent's Profile TTS configuration.
---

Completed group replies bind their responding Agent's Profile to the autoplay
event before entering a prepared FIFO queue. TTS synthesis starts as soon as a
message is queued, with up to five different Profiles prepared concurrently.
Messages using the same Profile TTS remain single-flight so one provider
configuration is never called concurrently. A later reply may finish synthesis
early, but it cannot play until every earlier queued message finishes or fails.

The Profile is sent explicitly to the existing authenticated TTS synthesis
endpoint while the provider is left for the server to resolve from that
Profile's active stored TTS configuration. Manual playback on a group Agent
message follows the same Profile-aware synthesis path. Single-chat playback and
the MCU realtime voice pipeline keep their existing entry points and behavior.
