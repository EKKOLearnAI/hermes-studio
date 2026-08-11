---
date: 2026-08-06
pr: 2373
feature: Group chat room readiness and typing presence
impact: Group messages now wait for the active socket to rejoin before sending, while throttled typing presence appears only as a breathing light on other members' avatars.
---

The client keeps one reconnecting Socket.IO instance, coalesces room joins by
socket and room, and rejects failed join acknowledgements instead of allowing
room-dependent events to race ahead. Typing events are emitted as a bounded
heartbeat, validated against online room membership on the server, and expired
locally if a stop event is lost.
