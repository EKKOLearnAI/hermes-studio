# Durable global notifications

- issue: #2400
- pr: pending

## Scope

Hermes Studio now persists and delivers owner/profile-scoped in-app notifications for:

- direct chat completion, failure, tool approval, and clarification;
- group chat agent replies and group tool approval;
- workflow completion, failure, and node approval;
- reconciled Cron completion and failure metadata.

Approval and clarification notifications are marked read when their authoritative interaction resolves. Existing OS completion notifications remain available.

## Data and security boundaries

- SQLite records are scoped by authenticated owner and resolved Profile.
- The server ignores client-supplied owner/Profile values.
- Socket.IO delivery uses owner + Profile rooms.
- Dedupe keys prevent HTTP, Socket replay, reconnect, and polling duplicates.
- Notification deep links reuse existing router and API authorization boundaries.
