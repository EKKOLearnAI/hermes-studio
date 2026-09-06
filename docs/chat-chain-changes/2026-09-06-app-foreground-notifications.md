# App foreground notifications

Add profile-scoped `app.notification` events with stable request/run identities, generic kinds, resolution and emission timestamps. Exclude progress, aborts and queued continuations. No prompts or command content. Existing socket authentication and profile room isolation remain unchanged. Mobile clients must ignore snapshots/background replay and deduplicate per account/device.
