---
date: 2026-07-13
pr: pending
feature: Single-chat realtime voice mode
impact: Single-chat sessions can run browser speech recognition and queued sentence-level TTS through a full-screen voice overlay while reusing the existing chat session stream.
---

The single-chat settings menu now opens a realtime voice overlay without
changing the underlying chat transport or message store. Browser speech
recognition submits a turn after two seconds of silence, and assistant text is
cleaned and split into sentence-level speech segments. Up to five segments may
be synthesized concurrently, while playback and matching captions remain
strictly ordered.

The overlay exposes current tool activity, supports interrupting the active
run or playback from the voice animation, and identifies the selected agent.
Speech cleanup is shared with the MCU interaction path so tables, code,
reasoning blocks, URLs, emoji, and markup are not spoken aloud.
