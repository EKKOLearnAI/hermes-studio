---
date: 2026-07-01
pr: pending
feature: Global Agent MCU voice chat TTS playback
impact: MCU voice turns now segment assistant message deltas through a shared streaming speech segmenter before TTS synthesis, and abort in-flight TTS requests when the device interrupts playback.
---

The segmenter skips fenced code, table rows, markdown link URLs, and bare URLs so device speech starts earlier without reading unstable or non-speech content. Playback interrupts now propagate to pending `/api/hermes/tts/synthesize` fetches through AbortSignal instead of only dropping audio after synthesis completes.
