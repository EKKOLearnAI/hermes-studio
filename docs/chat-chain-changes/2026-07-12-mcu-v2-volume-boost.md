---
date: 2026-07-12
pr_or_commit: pending
feature: ESP32-C3 v2 playback boost
impact: Applies 1.5x playback gain behind the v2 0-100% volume control and uses a soft limiter to raise speech loudness without hard-clipping peaks.
---

Firmware v2 displays a conventional 0-100% volume range with an 80% default,
while its PCM playback path applies a fixed 1.5x multiplier. Displayed 80%
therefore produces 1.2x PCM gain and displayed 100% produces 1.5x gain. A soft
knee at 18000 and asymptotic ceiling of 28000 control peaks. The v2
implementation is source-isolated so this experiment does not modify v1.
