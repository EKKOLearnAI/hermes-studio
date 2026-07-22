---
date: 2026-07-22
pr: pending
feature: MCU background result speech
impact: MCU voice turns return to idle after the parent response and later speak only the final autonomous Agent response produced for completed background work.
---

The Global Agent server and the direct outbound MCU relay compatibility path
keep a hidden session listener while a voice-triggered Hermes run has pending
background delegations. Subagent telemetry and delegation lifecycle events
remain server-internal and are not forwarded to the MCU. When the background
completion starts its autonomous parent turn, the listener buffers that turn
and reuses the existing MCU audio queue only after `run.completed` provides the
final Agent output. Existing MCU firmware and the transparent remote relay
server require no protocol changes. An MCU interrupt received after the parent
turn is already idle no longer records a deferred session abort, so immediately
starting another recording leaves pending background delegations running; an
interrupt during an active foreground turn still aborts that turn normally.
Each MCU foreground run now carries an internal `queue_id`. When a new voice
turn is queued while an autonomous background delivery is returning on the
same chat session, MCU listeners use that identifier to keep the two event
streams separate. The existing background listener owns the autonomous result;
the new listener ignores it until its own queued run starts. This identifier is
not part of the MCU wire protocol, so older firmware remains compatible.
