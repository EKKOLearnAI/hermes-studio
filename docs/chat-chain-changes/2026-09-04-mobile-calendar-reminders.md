# Mobile calendar and reminders

Direct Hermes Studio chats can request one-time, user-confirmed access to mobile calendar events and reminders.

- MCP tools: `hermes_studio_use_mobile_calendar` and `hermes_studio_use_mobile_reminders`
- Server endpoint: `POST /api/studio/mobile-calendar/request`
- Calendar events: list, create, update
- Reminders: list, create, update, complete
- Delete, background access, workflow/group/delegated use, and cross-session persistence are not supported.
- Every request is bound to the authenticated profile and exact direct-chat session.
- App responses are allowlisted and sanitized before being returned to the MCP caller.

2026-09-05 integration update (PR #2892): merge current main while retaining
location, calendar and reminder routes, MCP operations, relay events and socket
lifecycles. Preserve distinct MCP test request IDs and expect the bound Studio
session environment in the global Codex resume regression.
