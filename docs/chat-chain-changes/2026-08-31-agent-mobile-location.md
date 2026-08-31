date: 2026-08-31
feature: Agent-requested one-time mobile location
impact: Direct-chat Agents can request the connected App's current WGS84 coordinates after an explicit one-time confirmation.

- Adds the `hermes_studio_use_mobile_location` managed MCP operation for direct chats.
- The current direct-chat session id is supplied in the run instructions so the
  MCP request remains session scoped.
- `/chat-run` emits `location.requested`, accepts `location.respond`, and emits
  `location.resolved`; App Relay allowlists the response event for LAN and cloud
  connections.
- Location responses are validated and reduced to coordinates, accuracy,
  optional altitude/speed, coordinate system, and timestamp. Address data is
  never accepted or persisted.
- Requests time out, are foreground/one-time only, and are unavailable to group
  chats, workflow nodes, delegated tasks, and background tracking.
