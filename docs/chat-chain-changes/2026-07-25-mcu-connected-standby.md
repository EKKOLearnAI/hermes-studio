---
date: 2026-07-25
pr_or_commit: pending
feature: MCU connected standby
impact: ESP32-C3 v1 and v2 firmware now turn off the OLED and power amplifier and enable Wi-Fi modem power saving after three idle minutes while preserving the MCU login and Socket.IO session.
---

Pressing the Listen/BOOT button or receiving a new MCU interaction restores
low-latency Wi-Fi and turns the OLED back on. This is not ESP32 deep sleep, so
the device does not reboot or reconnect when leaving standby. The MCU device
page persists a configurable 0–60 minute timeout in NVS; the default is three
minutes and zero disables automatic standby.
