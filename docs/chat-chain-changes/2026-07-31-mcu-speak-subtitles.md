---
date: 2026-07-31
pr_or_commit: pending
feature: MCU speak subtitles
impact: MCU speech subtitles now stay attached to the active audio segment and advance from actual playback progress without changing chat persistence, message ownership, tool events, or speech queue ordering.
---

The local and outbound MCU voice paths now keep the normalized TTS segment text
on both the `interaction.status` and `audio.enqueue` events. ESP32-C3 firmware
v1 and v2 render the text with a compressed GB2312 font while the matching audio
segment plays, wrapping it into three-line pages. Page timing follows elapsed
playback time capped by queued PCM or ADPCM sample progress, preventing I2S DMA
prebuffering from advancing the first page early. The old playback progress bar
is removed to make room for the third line. The subtitle is cleared only when
that segment's audio finishes or is interrupted. Subtitle payloads are kept
separate from the 180-byte status-detail preview, and page layout is calculated
over the complete TTS segment instead of stopping after a fixed number of
lines. Wrapped lines are cached once before playback. During audio playback,
the OLED sends only the subtitle rows and only when the page changes, so I²C
display traffic does not starve I2S.

This changes only the MCU presentation payload. Chat persistence, assistant
message ownership, tool events, and the speech playback queue remain unchanged.
