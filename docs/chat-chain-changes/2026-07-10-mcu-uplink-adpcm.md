---
date: 2026-07-10
pr: 2024
feature: MCU uplink IMA-ADPCM
impact: ESP32-C3 voice streams now use independently framed IMA-ADPCM chunks that the Global Agent server decodes to PCM before the existing STT flow.
---

Legacy MCU firmware that sends `audio/pcm` remains supported. Each compressed
chunk uses the existing HADP v1 container so the relay can forward it without
transcoding and the receiving server can validate and decode chunks separately.
