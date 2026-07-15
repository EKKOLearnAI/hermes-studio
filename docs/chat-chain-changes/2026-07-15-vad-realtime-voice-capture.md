---
date: 2026-07-15
pr: pending
feature: VAD realtime voice capture
impact: Mobile and Electron realtime voice now capture 16 kHz PCM/WAV with voice-activity-driven segments, while desktop browsers retain Web Speech recognition.
---

Mobile browsers and the macOS, Windows, and Linux desktop shells use the configured backend STT provider for dynamically segmented WAV transcription. Capture warms up before requiring sustained voice activity, natural pauses produce incremental captions, pure silence and provider no-speech responses are discarded, and 1.5 seconds of silence commits the complete turn on every platform. Manual microphone stops remain paused instead of immediately restarting, the submitted transcript remains visible while the agent thinks, and only replies from the current voice turn enter the speech playback queue.

The STT settings test also records a single PCM/WAV sample instead of using platform-specific MediaRecorder output. This avoids Windows WebM/Opus and macOS MP4/AAC compatibility failures plus Electron's unavailable browser speech network service without changing the existing desktop-browser path. Desktop permission handling now requests microphone access through Electron on macOS and permits the main renderer's audio request on Windows and Linux; packaged macOS builds include the required microphone usage description.
