---
date: 2026-08-12
pr: pending
feature: App Relay binary media and uploads
impact: App chat can relay TTS audio and upload image or file bytes to the selected Studio profile without Base64 encoding or cloud file persistence.
---

The App Relay HTTP envelope now preserves Socket.IO binary frames in both LAN
and cloud modes. App uploads use authenticated 256 KB request chunks and only
assemble the final file inside the selected Hermes Studio profile upload
directory. Incomplete device-side uploads expire after ten minutes.
