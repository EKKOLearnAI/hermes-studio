# App foreground notifications

Add profile-scoped `app.notification` events with stable request/run identities, generic kinds, resolution and emission timestamps. Exclude progress, aborts and queued continuations. No prompts or command content. Existing socket authentication and profile room isolation remain unchanged. Mobile clients must ignore snapshots/background replay and deduplicate per account/device.

## Unified transport revision

The new App companion negotiates schema 1 on the existing `/chat-run` namespace,
receives only `app.event`, and delegates presentation to the existing local settings.
See `docs/app-business-events.md` for event types, filters, compatibility and channel
isolation. Legacy output is now a consumer of the same source, not assembled by the
three business sockets. HTTP and social projection/scope are intentionally unchanged.
