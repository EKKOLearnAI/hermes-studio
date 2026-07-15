---
date: 2026-07-12
pr_or_commit: pending
feature: MCU remote disconnect synchronization
impact: Paired MCU devices clear their remote login when the remote Hermes client disconnects, and logged-out devices cannot start voice capture.
---

The public relay now emits `mcu.remote.disconnected` when the active remote
client disconnects. It also checks for a connected remote client after an MCU
comes online, so an MCU that was powered off during the disconnect still clears
its stale login. Matching v1 and v2 firmware stops queued audio, ends the active
interaction, clears the saved remote target and login, and disconnects its
Socket transport. Long-press voice capture also requires a local target, token,
and Profile before it can enter `LISTEN`.

Remote machine discovery now releases the Relay Socket transport before opening
its HTTPS request and caps both TCP connect and TLS handshake time. This avoids
freezing the MCU web server for the platform's 120-second default TLS handshake
timeout when the device page is opened during Relay startup or reconnect.
