---
date: 2026-08-10
pr: 2459
feature: Local and remote group chat room list
impact: Invited Agent links retain their cloud room identity, and the main group chat sidebar separates locally hosted rooms from deduplicated remote rooms.
---

The outbound Agent Relay persists the cloud room ID and room name alongside the
existing cloud origin, connector credential, and Agent descriptor. Existing link
files remain valid; their room metadata is filled after the next successful
Relay connection.

The non-standalone group chat sidebar reads those safe connection summaries and
groups rooms into independently collapsible local and remote sections, omitting
either section when it has no rooms. Remote entries use the normalized cloud
origin and room ID as their identity and collapse multiple Agent connectors for
the same remote room without removing entries across the local/remote boundary.
Selecting a remote room opens its cloud-hosted invite share route rather than
an authenticated internal room route.

Remote room context-menu actions can set a device-local display alias or leave
the room. Leaving groups all persisted links by cloud origin and room ID,
notifies every reachable cloud connector to revoke and remove its Agent, stops
local reconnection, and removes every matching link from the local file. When a
cloud service is temporarily unreachable, local records are still removed and
the UI reports how many remote revocations could not be delivered.

Member removal and Agent deletion from the shared avatar rail execute directly
without an extra confirmation popover. Agent deletion from the edit dialog uses
the same direct behavior. Because the local and invite-only views share the
panel, both entry points remain consistent.
