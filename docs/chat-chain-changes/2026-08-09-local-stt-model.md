---
date: 2026-08-09
pr: pending
feature: Local Chinese-English STT model download and streaming capture
impact: Hermes Studio can download, verify, install, and activate a bundled local STT model without blocking the server; realtime voice mode and local chat-input dictation receive incremental transcripts from PCM chunks.
---

The STT settings page now includes a fixed local Chinese-English Zipformer
card. Users can download the pinned model from Cloudflare or GitHub, follow
download and installation progress, and activate it only after checksum,
archive, file-size, and native runtime validation succeeds.

Local inference runs in a reusable child process so the recognizer and model are
loaded once instead of accumulating one native runtime per request. Realtime
voice mode opens a local recognition session, uploads roughly one-second PCM WAV
chunks, displays the recognizer's cumulative partial text, and finalizes the
same stream at the end of the utterance. The child process is stopped after an
idle period and is explicitly terminated during server shutdown; abandoned
stream sessions are also reclaimed automatically.

When local STT is selected, the chat input microphone uses the same incremental
PCM session and displays partial text while recording, matching the browser STT
interaction. Stopping commits only the final transcript into the editable
draft. Remote providers such as OpenAI and Doubao keep the existing single-shot
flow: record the complete utterance first, then upload it for transcription.
The one-second local chunks are transport frames rather than utterance
boundaries: they preserve every PCM sample in order, and stopping always flushes
the remaining tail even when it is shorter than the normal VAD threshold.

The local path accepts PCM WAV and raw 16 kHz mono s16le PCM by wrapping it in
memory, and never requires ffmpeg for recording conversion. The sherpa native
runtime is pinned to 1.13.3 because 1.13.4 bundles an ONNX Runtime regression
that silently breaks streaming Zipformer inference on SME-capable Apple
Silicon. Desktop packages verify their target sherpa-onnx native runtime, while
npm selects and downloads the matching native runtime for the user's operating
system and CPU during installation.
