---
date: 2026-07-14
pr: pending
feature: PC realtime voice no-speech recovery
impact: PC browser speech recognition now restarts listening after a no-speech result instead of treating silence as a fatal voice-chain error.
---

Realtime voice uses continuous browser recognition on PC. When the browser
reports `no-speech`, only the failed browser recognition instance is cleared
and restarted after the normal short delay; the microphone recorder and
visualizer stream remain open. Network, permission, and other recognition
failures keep their existing error and backend-fallback behavior.
