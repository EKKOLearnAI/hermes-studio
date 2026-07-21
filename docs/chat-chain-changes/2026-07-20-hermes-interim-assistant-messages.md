---
date: 2026-07-20
pr: 2160
feature: Hermes interim assistant messages
impact: Hermes 0.19 mid-turn commentary is preserved as authoritative, independently persisted assistant messages without duplicating streamed text.
---

The Agent Bridge forwards `message.interim` with its `already_streamed` marker.
The server reconciles the authoritative text with any streamed prefix before
sealing the message, and clients start a new assistant bubble for later output.
