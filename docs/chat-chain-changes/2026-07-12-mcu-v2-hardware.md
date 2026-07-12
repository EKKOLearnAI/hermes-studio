---
date: 2026-07-12
pr_or_commit: pending
feature: ESP32-C3 v2 firmware family
impact: Adds a version-isolated firmware target for the 16MB hardware revision while sharing the v1 chat, audio, relay, and OTA logic.
---

Firmware v2 reuses the v1 application implementation and overrides its
firmware version, v2 manifest path, and xmini-c3 hardware pin map: battery ADC
GPIO2, shared OLED/ES8311 I2C on GPIO3/4, I2S on GPIO5/6/7/8/10, BOOT on GPIO9,
and PA enable on GPIO11. Its
OTA manifest and binary routes are isolated under `/api/hermes/mcu/firmware/v2`
so v1 devices remain pinned to v1 firmware. Both firmware targets declare the
hardware's 16MB physical flash while retaining the established 4MB dual-OTA
partition layout. The v2 ES8311 DAC volume register uses `0xBF` (0dB), while v1
retains its existing `0xC0` setting. Firmware v2 defaults playback volume to
100%, while v1 retains its 70% default.
